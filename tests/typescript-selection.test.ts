// One golem process loads one TypeScript: the one beside the tsconfig of the project a host opens, wherever the process runs from.
// Each case runs in a fresh process, because the process keeps the TypeScript it first selected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { command, workspace } from './support/process.js';

const tooling = (name: string): string => pathToFileURL(path.join(workspace, 'packages/golem/dist/tooling', name)).href;
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-typescript-selection-')));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function directory(): string {
  const created = path.join(scratch, `case-${counter++}`);
  fs.mkdirSync(created, { recursive: true });
  return created;
}

/** A directory whose node_modules holds a `typescript` of this version, for the part of the selection that reads versions only. */
function fakeInstall(version: string): string {
  const root = directory();
  fs.mkdirSync(path.join(root, 'node_modules/typescript'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/typescript/package.json'), JSON.stringify({ name: 'typescript', version }));
  return root;
}

/** A directory that resolves the same `typescript` as `install`, through a link of its own. */
function linkedTo(install: string): string {
  const root = directory();
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(path.join(install, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'dir');
  return root;
}

/** Run a module script in a process started from `cwd` with no TypeScript root of the user's; the script prints one JSON value. */
async function run(cwd: string, script: string, env: NodeJS.ProcessEnv = { GOLEM_TYPESCRIPT_ROOT: undefined }): Promise<unknown> {
  const result = await command(cwd, process.execPath, ['--input-type=module', '-e', script], { env });
  return JSON.parse(result.stdout);
}

const attempt = `const attempt = (use) => { try { use(); return null; } catch (error) { return error.message; } };`;

test('a second project on the install the process holds is accepted, reached through a link or not; one on another install is refused', async () => {
  const first = fakeInstall('6.0.3');
  const sameInstall = linkedTo(first);
  const other = fakeInstall('6.0.4');
  const cwd = directory();
  const answer = await run(cwd, `import { requestTypeScriptRoot, selectedTypeScript } from '${tooling('typescript-selection.js')}';
${attempt}
const accepted = [attempt(() => requestTypeScriptRoot(${JSON.stringify(first)})), attempt(() => requestTypeScriptRoot(${JSON.stringify(sameInstall)}))];
const version = selectedTypeScript().version;
const refused = attempt(() => requestTypeScriptRoot(${JSON.stringify(other)}));
console.log(JSON.stringify({ accepted, version, refused }));`);
  assert.deepEqual(answer, {
    accepted: [null, null],
    version: '6.0.3',
    refused: `One golem process loads one TypeScript: 6.0.3 at ${path.relative(cwd, fs.realpathSync(path.join(first, 'node_modules/typescript')))} was selected from the project at ${path.relative(cwd, first)}, but the project at ${path.relative(cwd, other)} uses 6.0.4 at ${path.relative(cwd, fs.realpathSync(path.join(other, 'node_modules/typescript')))}. Run one golem build tool per TypeScript install.`,
  });
});

test('a request that arrives after the working directory chose the TypeScript names where the choice came from', async () => {
  const working = fakeInstall('6.0.3');
  const other = fakeInstall('6.0.4');
  const answer = await run(working, `import { requestTypeScriptRoot, selectedTypeScript } from '${tooling('typescript-selection.js')}';
${attempt}
const version = selectedTypeScript().version;
const same = attempt(() => requestTypeScriptRoot(${JSON.stringify(linkedTo(working))}));
const refused = attempt(() => requestTypeScriptRoot(${JSON.stringify(other)}));
console.log(JSON.stringify({ version, same, refused }));`) as { version: string; same: string | null; refused: string };
  assert.equal(answer.version, '6.0.3');
  assert.equal(answer.same, null);
  assert.match(answer.refused, /^One golem process loads one TypeScript: 6\.0\.3 at .* was selected from the working directory .*before any project asked for its TypeScript.*uses 6\.0\.4 at /);
});

test('GOLEM_TYPESCRIPT_ROOT is the TypeScript of the process and no request is compared with it', async () => {
  const override = fakeInstall('6.0.3');
  const other = fakeInstall('6.0.4');
  const answer = await run(directory(), `import { requestTypeScriptRoot, selectedTypeScript } from '${tooling('typescript-selection.js')}';
${attempt}
const before = attempt(() => requestTypeScriptRoot(${JSON.stringify(other)}));
const version = selectedTypeScript().version;
const after = attempt(() => requestTypeScriptRoot(${JSON.stringify(other)}));
console.log(JSON.stringify({ before, version, after }));`, { GOLEM_TYPESCRIPT_ROOT: override });
  assert.deepEqual(answer, { before: null, version: '6.0.3', after: null });
});

test('two copies of the module in one process share one TypeScript choice', async () => {
  // protects: T-8 regression, a nested copy of golem (the generators depend on it) did not see the golem command's choice
  const requested = fakeInstall('6.0.3');
  const working = fakeInstall('6.0.4');
  const copy = (name: string): string => `${tooling('typescript-selection.js')}?copy=${name}`;
  const answer = await run(working, `const first = await import('${copy('first')}');
const second = await import('${copy('second')}');
first.requestTypeScriptRoot(${JSON.stringify(requested)});
console.log(JSON.stringify({ version: second.selectedTypeScript().version, same: first.selectedTypeScript().version }));`);
  assert.deepEqual(answer, { version: '6.0.3', same: '6.0.3' });
});

/** A project of a golem.yaml and a tsconfig whose directory holds the TypeScript at `node_modules/typescript`, a link to `typescript` or a directory of the given fake version. */
function project(typescript: string | { readonly version: string }): string {
  const root = typeof typescript === 'string' ? directory() : fakeInstall(typescript.version);
  if (typeof typescript === 'string') {
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(typescript, path.join(root, 'node_modules/typescript'), 'dir');
  }
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: .\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true }, include: ['src/**/*.ts'] }));
  fs.writeFileSync(path.join(root, 'src/plain.ts'), 'export const plain = 1;\n');
  return root;
}

/** Open each project's host from `cwd`, which holds no TypeScript, and ask it about a file without a rewrite site. */
function opened(cwd: string, roots: readonly string[]): Promise<unknown> {
  return run(cwd, `import { openRewriteProject } from '${tooling('rewrite-host.js')}';
const results = [];
for (const root of ${JSON.stringify(roots)}) {
  try {
    const project = await openRewriteProject({ cwd: root });
    results.push({ rewritten: project.rewrite(root + '/src/plain.ts', 'export const plain = 1;\\n') !== undefined });
    project.close();
  } catch (error) {
    results.push({ error: error.message });
  }
}
console.log(JSON.stringify(results));`);
}

test('a host opened from a directory without TypeScript loads the TypeScript beside the tsconfig of its project', async () => {
  const unsupported = project({ version: '5.9.0' });
  const [result] = await opened(directory(), [unsupported]) as { error?: string }[];
  assert.match(result.error ?? '', /golem supports TypeScript 6\.0\+ and 7\.1\+; found 5\.9\.0 at .*case-\d+[\\/]node_modules[\\/]typescript/);
});

test('two projects that share one TypeScript install both open in one process', async () => {
  const shared = path.join(workspace, 'node_modules/typescript');
  assert.deepEqual(await opened(directory(), [project(shared), project(shared)]), [{ rewritten: false }, { rewritten: false }]);
});

test('a project whose TypeScript failed to load does not block the next project', async () => {
  // protects: T-8 a request that never took effect is replaced, not compared
  const [first, second] = await opened(directory(), [project({ version: '5.9.0' }), project(path.join(workspace, 'node_modules/typescript'))]) as [{ error?: string }, unknown];
  assert.match(first.error ?? '', /found 5\.9\.0/);
  assert.deepEqual(second, { rewritten: false });
});
