// Shared fixtures and helpers of the golem build suites: build-command, build-command-config and build-command-watch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type TestContext } from 'node:test';
import { runBuild } from '#golem/build';
import { decodeMappings } from '#golem/source-map';
import { resolveTypeScript } from '#golem/typescript-version';
import { generate } from '#model/generator';
import { copyFixtureFile, writeGeneratedArtifacts } from '../fixture-project.js';
import { createModelProject, MINIMAL_GOLEM_YAML } from '../model-project.js';
import { command, golem, workspace } from './process.js';

export const TSC = path.join(resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? workspace).packageDir, 'bin/tsc');
export const PROFILE = { mobx: false, validation: true } as const;
/** A heavy test is bounded below the file's 90 s budget, so a kill names the test. */
export const HEAVY_TEST_TIMEOUT_MS = 45_000;
export const REJECTION = 'golem build does not support project references (-b); run golem build -p <tsconfig> per project.';

// Fixture projects

export function write(root: string, relative: string, text: string): void {
  writeGeneratedArtifacts([{ path: path.join(root, relative), content: text }]);
}

export function editTsconfig(root: string, edit: (tsconfig: { compilerOptions: Record<string, unknown>; include?: string[]; files?: string[]; [key: string]: unknown }) => void, name = 'tsconfig.json'): void {
  const file = path.join(root, name);
  const tsconfig = JSON.parse(fs.readFileSync(file, 'utf8')) as { compilerOptions: Record<string, unknown> };
  edit(tsconfig);
  fs.writeFileSync(file, JSON.stringify(tsconfig));
}

/** A serde project (the shared money model and its generated files) with `declaration` and `sourceMap` on; the caller adds sources. */
export function serdeProject(t: TestContext, name: string): string {
  const { root } = createModelProject(t, {
    prefix: 'golem-build-',
    name,
    linkTypescript: true,
    compilerOptions: { declaration: true, sourceMap: true },
  });
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  writeGeneratedArtifacts(generate({ root, profile: PROFILE }).artifacts);
  write(root, 'golem.yaml', MINIMAL_GOLEM_YAML);
  return root;
}

export const USE = `import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
import './money.model.js';

export const text = stringify<TMoney>({ currency: 'USD', value: '1' });
export const money = parse<TMoney>(text);
`;

/** Every file of the project that is neither a dependency nor something golem build writes: its bytes and mtime. */
export function snapshot(root: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (['node_modules', '.golem', 'build', 'types'].includes(entry.name)) continue;
      if (entry.isDirectory()) { visit(filename); continue; }
      files.set(path.relative(root, filename), `${fs.statSync(filename, { bigint: true }).mtimeNs}:${fs.readFileSync(filename, 'utf8')}`);
    }
  };
  visit(root);
  return files;
}

/** Runs `action`, then asserts that no source or generated file of the project changed: bytes and mtimes. */
async function withoutSourceEdits<T>(root: string, action: () => Promise<T>): Promise<T> {
  const before = snapshot(root);
  try {
    return await action();
  } finally {
    assert.deepEqual(snapshot(root), before, 'golem build changed a file it does not own');
  }
}

/** Builds in this process with the project's golem.yaml named explicitly: the test process's working directory plays no part. */
export function build(root: string, project?: string, config = path.join(root, 'golem.yaml')): Promise<{ exitCode: number }> {
  return withoutSourceEdits(root, () => runBuild({ ...(project === undefined ? {} : { project: path.join(root, project) }), watch: false, config }));
}

export function mtimes(directory: string, suffix: string): Map<string, bigint> {
  const found = new Map<string, bigint>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith(suffix)) found.set(path.relative(directory, filename), fs.statSync(filename, { bigint: true }).mtimeNs);
    }
  };
  visit(directory);
  return found;
}

export function importBuilt(root: string, file: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(path.join(root, 'build', file)).href) as Promise<Record<string, unknown>>;
}

export function golemBuild(root: string, args: readonly string[]) {
  return withoutSourceEdits(root, () => command(root, process.execPath, [golem, 'build', ...args], { allowFailure: true }));
}

/** The map of a built file resolves the rewritten `stringify` call of `USE` to its line and column in `source`. */
export function assertCallMap(root: string, built: string, source: string): void {
  const generated = fs.readFileSync(path.join(root, built), 'utf8').split('\n');
  const mapFile = path.join(root, `${built}.map`);
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { sources: string[]; mappings: string };
  assert.deepEqual(map.sources.map((entry) => path.resolve(path.dirname(mapFile), entry)), [path.join(root, source)]);
  const line = generated.findIndex((text) => text.includes('.stringify('));
  assert.notEqual(line, -1);
  const column = generated[line]!.indexOf('requireObjectCodec');
  const segments = decodeMappings(map.mappings)[line]!;
  const segment = [...segments].reverse().find((candidate) => candidate[0]! <= column);
  assert.ok(segment, 'a segment covers the rewritten call');
  const original = USE.split('\n');
  const originalLine = original.findIndex((text) => text.startsWith('export const text'));
  assert.equal(segment[2], originalLine, 'the original line');
  assert.equal(segment[3], original[originalLine]!.indexOf('stringify<TMoney>'), 'the original column');
}
