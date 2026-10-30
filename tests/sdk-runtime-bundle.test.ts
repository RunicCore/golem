import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createFixtureProject, fileFixtureScope, onceShared } from './fixture-project.js';
import { repoRoot, tscBin } from './openapi/helpers.js';

const scope = fileFixtureScope();
const shipped = path.join(repoRoot(), 'packages/golem-openapi/sdk-runtime');

// The values that SDK code generated for a client, its schema groups and its validators imports at runtime.
const generatedSdkImports = [
  'ClientRuntime', 'IssueRepresentation', 'IssueSource', 'addQueryParameter', 'applySecurity', 'assertModelValue', 'assertPropertyAcyclic',
  'callLevels', 'checkFormat', 'codePointLength', 'convertModelField', 'convertRequestParameters', 'createApiOperation', 'createObjectCodec',
  'decodeCheckedInput', 'decodeDetachedInput', 'defineModelProperty', 'deserializeDate', 'deserializeTemporalInstant', 'encodeBody',
  'formatTest', 'isUndeclaredResponseError', 'isValidModelValue', 'jsonEqual', 'operationValidators', 'parseJson', 'responseCheck',
  'responseDecoder', 'serdeValidates', 'serializeContentParameter', 'serializeDate', 'serializeHeaderSimple', 'serializePath',
  'serializeTemporalInstant', 'stringifyJsonNumber', 'stringifyJsonScalar', 'stringifyJsonString', 'unknownDiscriminatorValue',
  'validateOperationInput', 'withDeclaredFields', 'withDiscriminatorValue',
];

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
  writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, target: 'ES2022',
      module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, lib: ['ES2023', 'DOM'], types: [], rootDir: 'src', outDir: 'out',
    },
    include: ['src/**/*.ts'],
  }));
  const compiled = spawnSync(process.execPath, [tscBin(), '-p', path.join(project, 'tsconfig.json')], { encoding: 'utf8' });
  return { project, compiled };
});

test('a plain tsc consumer with no golem installed compiles the shipped SDK runtime and runs it', async (t) => {
  // protects: T-693 R-83 standalone SDK bundles the golem runtime
  const bundle = readFileSync(path.join(shipped, 'runtime.impl.ts'), 'utf8');
  t.diagnostic(`SDK runtime: ${Buffer.byteLength(bundle)} bytes minified, ${gzipSync(bundle, { level: 9 }).length} bytes gzip`);
  const { project, compiled } = await compiledConsumer();
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const ran = spawnSync(process.execPath, [path.join(project, 'out/main.js')], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), '{"iso":"1970-01-01T00:00:00.000Z","url":"https://api.example.test/charges","thrown":"LibError","depth":4,"issues":0}');
});

test('the shipped SDK runtime exports every name generated SDK code imports and holds no model class registry', async () => {
  // protects: T-693 R-83 the runtime exports what generated code imports, with no registry
  const { project } = await compiledConsumer();
  const names = Object.keys(await import(pathToFileURL(path.join(project, 'out/rt/runtime.impl.js')).href) as object);
  assert.deepEqual(generatedSdkImports.filter((name) => !names.includes(name)), []);
  assert.deepEqual(names.filter((name) => /^(?:register|find|get)(?:Generated|Object)|^requireObjectCodec$/.test(name)), []);
});
