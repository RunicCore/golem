import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { build } from 'esbuild';
import { createFixtureProject, fileFixtureScope, onceShared } from './fixture-project.js';
import { repoRoot, tscBin, writePlainTscProject } from './openapi/helpers.js';

const scope = fileFixtureScope();
const shipped = path.join(repoRoot(), 'packages/golem-openapi-ts/sdk-runtime');

const consumer = `import { ClientRuntime, LibError, deserializeDate, serializeDate } from './rt/runtime.js';
import type { ClientRuntime as Runtime, SchemaIssue, ValidateOptions } from './rt/runtime.types.js';
const runtime: Runtime = new ClientRuntime('Pay', { baseUrl: 'https://api.example.test' });
const options: ValidateOptions = { maxDepth: 4 };
const issues: SchemaIssue[] = [];
let thrown = '';
try { deserializeDate('not a date'); } catch (error) { thrown = error instanceof LibError ? 'LibError' : 'other'; }
console.log(JSON.stringify({ iso: serializeDate(new Date(0)), url: runtime.url('/charges', []), thrown, depth: options.maxDepth, issues: issues.length }));
`;

// The shipped files, copied into a project that has no golem and compiled by plain tsc.
const compiledConsumer = onceShared(async () => {
  const project = createFixtureProject(scope, 'golem-sdk-runtime-');
  cpSync(shipped, path.join(project, 'src/rt'), { recursive: true });
  writeFileSync(path.join(project, 'src/main.ts'), consumer);
  writeFileSync(path.join(project, 'package.json'), '{"type":"module"}\n');
  writePlainTscProject(project);
  const compiled = spawnSync(process.execPath, [tscBin(), '-p', path.join(project, 'tsconfig.json')], { encoding: 'utf8' });
  return { project, compiled };
});

test('a plain tsc consumer with no golem installed compiles the shipped SDK runtime and runs it', async (t) => {
  // protects: T-693 R-83 standalone SDK bundles the golem runtime; T-712 it loads and converts with no registry module beside it
  const bundle = readFileSync(path.join(shipped, 'runtime.impl.ts'), 'utf8');
  t.diagnostic(`SDK runtime: ${Buffer.byteLength(bundle)} bytes minified, ${gzipSync(bundle, { level: 9 }).length} bytes gzip`);
  const { project, compiled } = await compiledConsumer();
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const ran = spawnSync(process.execPath, [path.join(project, 'out/main.js')], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), '{"iso":"1970-01-01T00:00:00.000Z","url":"https://api.example.test/charges","thrown":"LibError","depth":4,"issues":0}');
});

/** Bundles an entry that imports the given names through the shipped facade with esbuild, as a user's build does, and gives the bundle and what it prints. */
async function bundleThroughFacade(names: string, use: string): Promise<{ code: string; stdout: string }> {
  const project = createFixtureProject(scope, 'golem-sdk-shake-');
  cpSync(shipped, path.join(project, 'rt'), { recursive: true });
  writeFileSync(path.join(project, 'main.ts'), `import { ${names} } from './rt/runtime.js';\nconsole.log(${use});\n`);
  const outfile = path.join(project, 'out/main.mjs');
  await build({ absWorkingDir: project, entryPoints: ['main.ts'], bundle: true, minify: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const ran = spawnSync(process.execPath, [outfile], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return { code: readFileSync(outfile, 'utf8'), stdout: ran.stdout.trim() };
}

test('an esbuild bundle of a module that imports one runtime function from the shipped facade keeps only that function', async () => {
  // protects: T-714 R-88 a standalone SDK bundles only the runtime functions it imports, in esbuild as in Rollup
  // The warning text is written inside createApiOperation only, so it marks that function in the bundle.
  const marker = 'Concurrent execute() invocation';
  const date = await bundleThroughFacade('serializeDate', 'serializeDate(new Date(0))');
  assert.equal(date.stdout, '1970-01-01T00:00:00.000Z');
  assert.ok(!date.code.includes(marker), 'createApiOperation is in a bundle that does not import it');
  const operation = await bundleThroughFacade('createApiOperation', 'typeof createApiOperation');
  assert.equal(operation.stdout, 'function');
  assert.ok(operation.code.includes(marker), 'the marker is not found in a bundle that imports createApiOperation');
});
