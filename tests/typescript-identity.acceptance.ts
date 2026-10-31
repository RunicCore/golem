// TypeScript 6 and 7 must write the same bytes. Each case of the identity corpus (tests/support/identity-corpus.ts) is generated and
// rewritten in child processes of each version: the generated files, the rewritten source text and the diagnostics are compared.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { copyFixtureFile, createFixtureProject, fileFixtureScope, fixturePath, onceShared, readFixture, writeGeneratedArtifacts, type FixtureScope } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { resolveTypeScript } from '#golem/typescript-version';
import { createModelProject } from './model-project.js';
import { caseFolder, DIAGNOSTICS, EXPECTED_REJECTIONS, GENERATED, IDENTITY_CASES, isCompiled, shardOf, type IdentityCase, type IdentityProject } from './support/identity-corpus.js';
import { createNodeSpecifierProject } from './support/node-specifiers-project.js';
import { command, workspace } from './support/process.js';
import { mtimes } from './support/build-project.js';

const typescript6Root = process.env.GOLEM_TYPESCRIPT6_ROOT;
// The shard counts keep the peak memory of the children beside the unit step low; TypeScript 6 runs slower per case, so it has more shards.
const SEVEN_SHARDS = 3;
const SIX_SHARDS = 4;
const SDK_ONLY_WIRE_CLAIM = 'wire-format/nested-sdk';

interface ShardRun {
  readonly cases: ReadonlySet<string>;
  /** The projects the child generated in; the generator wrote its files into them. */
  readonly projects: readonly IdentityProject[];
  readonly typescriptVersion: string | undefined;
  /** What the child printed to stderr when it ended non-zero, else undefined. */
  readonly failure: string | undefined;
  /** The files the child wrote, keyed by path relative to its output directory. */
  readonly artifacts: ReadonlyMap<string, string>;
}

interface IdentityRun {
  readonly seven: readonly ShardRun[];
  readonly six: readonly ShardRun[];
}

/** The project of one case: the fixture files in place, the SDK of an SDK case written beside them. */
async function createProject(t: FixtureScope, item: IdentityCase, label: string): Promise<IdentityProject> {
  const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const prefix = `golem-identity-${label}-`;
  if (item.kind === 'controller') {
    // The rewrite's NestJS side is on for a program that imports golem's interceptor module.
    const files = { 'src/interceptor.ts': "export { NestModelInterceptor } from '@exprtlabs/golem/nest';\n", ...Object.fromEntries(item.files.map(file => [file.to, readFixture(file.from)])) };
    return { name: item.name, kind: item.kind, mobx: item.mobx, root: createControllerFixture(t, { prefix, files }) };
  }
  if (item.kind === 'specifiers') {
    // The jsx option makes the .tsx edge case spell its emitted extension, which the two versions must number alike.
    const root = createNodeSpecifierProject(t, { prefix, compilerOptions: { jsx: 'preserve' } });
    for (const file of item.files) copyFixtureFile(root, file.from, file.to);
    return { name: item.name, kind: item.kind, mobx: item.mobx, root };
  }
  const { root } = createModelProject(t, { prefix, name: `identity-${slug}`, linkTypescript: item.kind === 'rewrite' });
  for (const file of item.files) copyFixtureFile(root, file.from, file.to);
  if (item.sdkSpec) {
    writeGeneratedArtifacts((await generateOpenApi({
      input: fixturePath(item.sdkSpec),
      output: path.join(root, 'src/sdk'),
      name: 'Payments',
      profile: { mobx: item.mobx, validation: true },
    })).artifacts);
  }
  return { name: item.name, kind: item.kind, mobx: item.mobx, root };
}

function readTree(directory: string): Map<string, string> {
  if (!fs.existsSync(directory)) return new Map();
  // Latin-1 maps each byte to one character, so equal strings are equal bytes.
  return new Map([...mtimes(directory, '').keys()].map(file => [file, fs.readFileSync(path.join(directory, file), 'latin1')]));
}

/** Builds the projects of one shard, runs its child process on one TypeScript version and reads what the child wrote. */
async function runShard(t: FixtureScope, label: string, cases: readonly IdentityCase[], typescriptRoot: string | undefined): Promise<ShardRun> {
  const scratch = createFixtureProject(t, `golem-identity-out-${label}-`);
  const projectsFile = path.join(scratch, 'projects.json');
  const outputDirectory = path.join(scratch, 'artifacts');
  const projects = await Promise.all(cases.map((item, index) => createProject(t, item, `${label}-${index}`)));
  fs.writeFileSync(projectsFile, JSON.stringify(projects));
  // An explicit undefined removes GOLEM_TYPESCRIPT_ROOT even when this process runs in the TypeScript 6 lane.
  const result = await command(workspace, process.execPath, [path.join(workspace, '.build/tests/support/identity-generate.js'), projectsFile, outputDirectory], {
    env: { GOLEM_TYPESCRIPT_ROOT: typescriptRoot },
    allowFailure: true,
  });
  return {
    cases: new Set(cases.map(item => item.name)),
    projects,
    typescriptVersion: /^typescript (\S+)$/m.exec(result.stdout)?.[1],
    failure: result.code === 0 && result.signal === null ? undefined : `exit ${result.code ?? result.signal}\n${result.stderr.slice(-4000)}`,
    artifacts: readTree(outputDirectory),
  };
}

/** The projects of the children live until the file's last test ends. */
const scope = fileFixtureScope();

/** Every shard of both versions runs at once, once per test file. */
const generateOnce = onceShared(async (): Promise<IdentityRun> => {
  const [seven, six] = await Promise.all([
    Promise.all(Array.from({ length: SEVEN_SHARDS }, (_, index) => runShard(scope, `7-${index}`, shardOf(IDENTITY_CASES, SEVEN_SHARDS, index), undefined))),
    Promise.all(Array.from({ length: SIX_SHARDS }, (_, index) => runShard(scope, `6-${index}`, shardOf(IDENTITY_CASES, SIX_SHARDS, index), typescript6Root))),
  ]);
  return { seven, six };
});

/** The files of one case in a version's run, keyed by path relative to the case's folder. A shard that failed names the case it was in. */
function filesOfCase(shards: readonly ShardRun[], version: string, name: string): ReadonlyMap<string, string> {
  const shard = shards.find(candidate => candidate.cases.has(name));
  assert.ok(shard, `${name} belongs to a shard of TypeScript ${version}`);
  assert.equal(shard.failure, undefined, `the TypeScript ${version} child that held ${name} failed: ${shard.failure}`);
  const folder = `${caseFolder(name)}${path.sep}`;
  return new Map([...shard.artifacts].filter(([file]) => file.startsWith(folder)).map(([file, content]) => [file.slice(folder.length), content]));
}

/** The lines of a diagnostics file where a stage ended in an error, rather than reporting a diagnostic. */
function rejectionLines(diagnostics: string | undefined): string[] {
  return (diagnostics ?? '').split('\n').filter(line => /^(?:generate|rewrite) error: /.test(line));
}

/** The first line where the two texts differ, with two lines before it; a file that one version did not write shows as missing. */
function diffHunk(seven: string | undefined, six: string | undefined): string {
  const text = (content: string | undefined): string[] => (content === undefined ? ['<file missing>'] : Buffer.from(content, 'latin1').toString('utf8').split('\n'));
  const left = text(seven);
  const right = text(six);
  let line = 0;
  while (line < left.length && line < right.length && left[line] === right[line]) line++;
  const context = left.slice(Math.max(0, line - 2), line).map(value => `  ${value}`);
  return [`@@ line ${line + 1} @@`, ...context, ...left.slice(line, line + 3).map(value => `- TypeScript 7: ${value}`), ...right.slice(line, line + 3).map(value => `+ TypeScript 6: ${value}`)].join('\n');
}

/** Empty when the two versions wrote the same files; else one line that lists every differing path, then the first of them with its diff hunk. */
function describeDifference(name: string, seven: ReadonlyMap<string, string>, six: ReadonlyMap<string, string>): string {
  const paths = [...new Set([...seven.keys(), ...six.keys()])].sort();
  const differing = paths.filter(file => seven.get(file) !== six.get(file));
  const [first] = differing;
  return first === undefined ? '' : `${name}: TypeScript 6 and 7 differ in ${differing.length} of ${paths.length} files: ${differing.join(', ')}\nfirst: ${first}\n${diffHunk(seven.get(first), six.get(first))}`;
}

/**
 * The one TypeScript 6 compile: a folder for each compiled case, holding the sources of its project and the files the TypeScript 6 child
 * generated into it (the wire-check files and wire-assert.ts among them). It is a model project: ESM package, the workspace's node_modules,
 * so `tsc` reads the published types of @exprtlabs/golem, and the options of createModelProject with `noEmit` and a `rootDir` that holds
 * the case folders. Returns the root and the case that each folder belongs to; a model case whose generation was rejected has no file to compile.
 */
async function createCompileTree(shards: readonly ShardRun[]): Promise<{ readonly root: string; readonly casesByFolder: ReadonlyMap<string, string> }> {
  const { root } = createModelProject(scope, {
    prefix: 'golem-identity-compile-',
    name: 'identity-compile',
    linkWorkspaceNodeModules: true,
    rootDir: '.',
    compilerOptions: { noEmit: true },
    include: ['*/src/**/*.ts'],
  });
  const casesByFolder = new Map<string, string>();
  const withoutGeneratedFiles: string[] = [];
  for (const shard of shards) {
    for (const project of shard.projects) {
      const item = IDENTITY_CASES.find(candidate => candidate.name === project.name);
      assert.ok(item, `${project.name} is a case of the corpus`);
      const generated = [...filesOfCase(shards, '6', item.name).keys()].some(file => file.startsWith(`${GENERATED}${path.sep}`));
      if (!isCompiled(item)) continue;
      if (!generated) {
        withoutGeneratedFiles.push(item.name);
        continue;
      }
      fs.cpSync(path.join(project.root, 'src'), path.join(root, caseFolder(item.name), 'src'), { recursive: true });
      casesByFolder.set(caseFolder(item.name), item.name);
    }
  }
  // A compiled model case may have no generated file only when it claims a rejection; then every other one is in the compile.
  const unexpected = withoutGeneratedFiles.filter(name => !(name in EXPECTED_REJECTIONS));
  assert.deepEqual(unexpected, [], 'a model case that wrote no generated file on TypeScript 6 claims a rejection');
  const expectedCount = IDENTITY_CASES.filter(isCompiled).length - withoutGeneratedFiles.length;
  assert.equal(casesByFolder.size, expectedCount, 'the compile holds every model case that is not excluded and did not claim a rejection');
  // The SDK-only wire claim has no model for the generators, so it is no case of the corpus. Its check joins the compile with a standalone SDK
  // (MobX needs the golem mode and its models job; wire-format-sdk.test.ts claims the MobX SDK); the SDK generator loads no TypeScript, so this one run serves both versions.
  const sdkSource = path.join(root, caseFolder(SDK_ONLY_WIRE_CLAIM), 'src');
  fs.cpSync(fixturePath(SDK_ONLY_WIRE_CLAIM), sdkSource, { recursive: true });
  fs.copyFileSync(fixturePath('wire-format/wire-assert.ts'), path.join(sdkSource, 'wire-assert.ts'));
  writeGeneratedArtifacts((await generateOpenApi({
    input: path.join(sdkSource, 'payments.yaml'),
    output: path.join(sdkSource, 'sdk'),
    name: 'Payments',
    profile: { mobx: false, validation: true },
  })).artifacts);
  casesByFolder.set(caseFolder(SDK_ONLY_WIRE_CLAIM), SDK_ONLY_WIRE_CLAIM);
  return { root, casesByFolder };
}

/** The cases whose files a `tsc` error line names, in the order of the output. Paths in the output are relative to the compile folder. */
function casesNamedBy(output: string, casesByFolder: ReadonlyMap<string, string>): string[] {
  const folders = [...output.matchAll(/^([^\s(]+)\(\d+,\d+\): error TS\d+:/gm)].map(match => match[1]!.split('/')[0]!);
  return [...new Set(folders.flatMap(folder => casesByFolder.get(folder) ?? []))];
}

if (!typescript6Root) {
  // The entrypoint of the test container installs TypeScript 6 and exports its root; without it there is nothing to compare.
  test('TypeScript 6 is installed for the identity test', () => {
    assert.fail('GOLEM_TYPESCRIPT6_ROOT is not set: run this in the test container (npm run test -- tests/typescript-identity.acceptance.ts), where the entrypoint installs TypeScript 6');
  });
} else {
  test('the TypeScript 7 children ran TypeScript 7 and the TypeScript 6 children ran TypeScript 6', async () => {
    const { seven, six } = await generateOnce();
    // Each child must have run the version its side names, or the comparison below compares one compiler with itself.
    for (const shard of seven) assert.match(shard.typescriptVersion ?? `no version (${shard.failure})`, /^7\./, 'a child of the TypeScript 7 side ran TypeScript 7');
    for (const shard of six) assert.match(shard.typescriptVersion ?? `no version (${shard.failure})`, /^6\./, 'a child of the TypeScript 6 side ran TypeScript 6');
  });

  for (const item of IDENTITY_CASES) {
    test(item.name, async () => {
      const { seven, six } = await generateOnce();
      const sevenFiles = filesOfCase(seven, '7', item.name);
      const sixFiles = filesOfCase(six, '6', item.name);
      // The diagnostics file is always written; a case that wrote a file besides it, or a diagnostic, wrote an artifact.
      for (const [version, files] of [['7', sevenFiles], ['6', sixFiles]] as const) {
        assert.ok([...files].some(([file, content]) => file !== DIAGNOSTICS || content !== ''), `${item.name} wrote no artifact on TypeScript ${version}`);
      }
      // Only the cases that claim a rejection end in one, and each ends in the message it claims, on both versions.
      const claimed = EXPECTED_REJECTIONS[item.name];
      for (const [version, files] of [['7', sevenFiles], ['6', sixFiles]] as const) {
        const lines = rejectionLines(files.get(DIAGNOSTICS));
        const matches = claimed === undefined ? lines.length === 0 : lines.some(line => line.includes(claimed));
        assert.ok(matches, `${item.name} ${claimed === undefined ? 'ended in an error' : `did not end in the error "${claimed}"`} on TypeScript ${version}:\n${files.get(DIAGNOSTICS)}`);
      }
      const difference = describeDifference(item.name, sevenFiles, sixFiles);
      assert.ok(difference === '', difference);
    });
  }
  test('the files that TypeScript 6 generated type-check in one TypeScript 6 compile', async t => {
    const { six } = await generateOnce();
    const { root, casesByFolder } = await createCompileTree(six);
    t.diagnostic(`${casesByFolder.size} cases in the compile`);
    const tsc = path.join(resolveTypeScript(typescript6Root).packageDir, 'bin/tsc');
    const result = await command(root, process.execPath, [tsc, '-p', root, '--pretty', 'false'], { allowFailure: true });
    const output = `${result.stdout}${result.stderr}`.trim();
    const named = casesNamedBy(output, casesByFolder);
    assert.ok(result.code === 0 && result.signal === null, `tsc of TypeScript 6 failed (${result.code ?? result.signal}) in ${named.length > 0 ? `the cases ${named.join(', ')}` : 'no case file'}:\n${output}`);
  });
}
