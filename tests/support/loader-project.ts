// The project a Node loader test runs: a model project with `golem generate` done, and a child Node that runs one file through the loader.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { runPipeline } from '#golem/cli';
import { copyFixtureFile, createFixtureProject, linkProjectPackages, snapshotFilesystem, writeGeneratedArtifacts } from '../fixture-project.js';
import { createModelProject } from '../model-project.js';
import { command, workspace, type CommandResult } from './process.js';

export const NODE_FLAGS = ['--import', '@exprtlabs/golem/register', '--experimental-strip-types', '--enable-source-maps'] as const;
export const SERDE = '@exprtlabs/golem/serde';
export const MODELS_YAML = 'version: 1\nvalidation: false\nmodel: {}\n';

/** Under Node's type stripping every relative import names its `.ts` file. */
export const MAIN = `import { parse, stringify } from '${SERDE}';
import type { TMoney } from './money.model.ts';
import './money.model.ts';
import { twice } from './util.ts';

const text = stringify<TMoney>({ currency: 'USD', value: '1' });
const money = parse<TMoney>(text);
console.log(JSON.stringify({ money, twice: twice(21) }));
const trace = new Error('where am I').stack;
console.log(trace);
`;
const UTIL = 'export const twice = (value: number): number => value * 2;\n';

export function write(root: string, relative: string, text: string): void {
  writeGeneratedArtifacts([{ path: path.join(root, relative), content: text }]);
}

export function lineOf(source: string, prefix: string): number {
  return source.split(/\r?\n/).findIndex((text) => text.replace(/^\uFEFF/, '').startsWith(prefix)) + 1;
}

/** The mapped line of the stack frame that names `file`. */
export function frameLine(output: string, file: string): number {
  const frame = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+\\)?$`, 'm');
  return Number(output.match(frame)?.[1]);
}

/** The `packages` option links a workspace package into the project; `compilerOptions` and `include` add to the tsconfig. */
interface ProjectOptions {
  readonly generate?: boolean;
  readonly preserveSymlinks?: boolean;
  readonly packages?: Readonly<Record<string, string>>;
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
  readonly include?: readonly string[];
}

/** A project that runs under Node's type stripping. It runs `golem generate` unless told not to. */
export async function project(t: TestContext, name: string, options: ProjectOptions = {}): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-loader-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model'), ...options.packages },
    compilerOptions: { noEmit: true, allowImportingTsExtensions: true, ...(options.preserveSymlinks === true ? { preserveSymlinks: true } : {}), ...options.compilerOptions },
    ...(options.include === undefined ? {} : { include: options.include }),
  });
  write(root, 'golem.yaml', MODELS_YAML);
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'src/money.model.ts', fs.readFileSync(path.join(root, 'src/money.model.ts'), 'utf8').replace('.generated.js', '.generated.ts'));
  write(root, 'src/main.ts', MAIN);
  write(root, 'src/util.ts', UTIL);
  if (options.generate !== false) await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

/**
 * A workspace package `workspace-lib` linked into the node_modules of `root`; its `lib.ts` makes one parse call of the TMoney model of `root`.
 * Without `preserveSymlinks` the package links the golem runtime itself; with it the package finds the runtime through the node_modules of `root`, as a workspace install gives it.
 */
export function workspacePackage(t: TestContext, root: string, preserveSymlinks = false): string {
  const directory = createFixtureProject(t, 'golem-workspace-package-');
  if (!preserveSymlinks) linkProjectPackages(directory, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  write(directory, 'package.json', JSON.stringify({ name: 'workspace-lib', type: 'module', exports: './lib.ts' }));
  write(directory, 'lib.ts', `import { parse } from '${SERDE}';\nimport type { TMoney } from '${path.join(root, 'src/money.model.ts')}';\nexport const value = parse<TMoney>('{"currency":"USD","value":"1"}');\n`);
  linkProjectPackages(root, { 'workspace-lib': directory });
  return directory;
}

/** Runs the loader in a child Node, then asserts that the loader changed no file of the project: bytes and mtimes. */
export async function run(root: string, file: string, options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly flags?: readonly string[] } = {}): Promise<CommandResult> {
  const before = snapshotFilesystem(root);
  const result = await command(options.cwd ?? root, process.execPath, [...NODE_FLAGS, ...(options.flags ?? []), file], { allowFailure: true, ...(options.env ? { env: options.env } : {}) });
  assert.deepEqual(snapshotFilesystem(root), before, 'the loader changed a file of the project');
  return result;
}
