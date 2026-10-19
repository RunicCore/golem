// TypeScript 6 and 7 must write the same bytes. Each case of the identity corpus (tests/support/identity-corpus.ts) is generated and
// rewritten in child processes of each version: the generated files, the rewritten source text and the diagnostics are compared.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { copyFixtureFile, createFixtureProject, fileFixtureScope, fixturePath, onceShared, readFixture, writeGeneratedArtifacts, type FixtureScope } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { createModelProject } from './model-project.js';
import { caseFolder, DIAGNOSTICS, IDENTITY_CASES, shardOf, type IdentityCase, type IdentityProject } from './support/identity-corpus.js';
import { command, workspace } from './support/process.js';

const typescript6Root = process.env.GOLEM_TYPESCRIPT6_ROOT;
// The shard counts keep the peak memory of the children beside the unit step low; TypeScript 6 runs slower per case, so it has more shards.
const SEVEN_SHARDS = 3;
const SIX_SHARDS = 4;

interface ShardRun {
  readonly cases: ReadonlySet<string>;
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
    const files = Object.fromEntries(item.files.map(file => [file.to, readFixture(file.from)]));
    return { name: item.name, kind: item.kind, mobx: item.mobx, root: createControllerFixture(t, { prefix, files }) };
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
  const files = new Map<string, string>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      // Latin-1 maps each byte to one character, so equal strings are equal bytes.
      if (entry.isDirectory()) visit(filename);
      else files.set(path.relative(directory, filename), fs.readFileSync(filename, 'latin1'));
    }
  };
  if (fs.existsSync(directory)) visit(directory);
  return files;
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

if (!typescript6Root) {
  // The entrypoint of the test container installs TypeScript 6 and exports its root; without it there is nothing to compare.
  test('TypeScript 6 is installed for the identity test', () => {
    assert.fail('GOLEM_TYPESCRIPT6_ROOT is not set: run this in the test container (npm run test -- tests/typescript-identity.test.ts), where the entrypoint installs TypeScript 6');
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
      const difference = describeDifference(item.name, sevenFiles, sixFiles);
      assert.ok(difference === '', difference);
    });
  }
}
