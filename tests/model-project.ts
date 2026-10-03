import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

import { command, golem, type CommandOptions, type CommandResult } from './support/process.js';
import {
  createFixtureProject,
  linkProjectPackages,
} from './fixture-project.js';
import type { SourceFragment } from './source-template.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));

interface ModelProjectOptions {
  readonly prefix: string;
  readonly name?: string | null;
  readonly rootDir?: string;
  readonly outDir?: string;
  readonly allowJs?: boolean;
  readonly checkJs?: boolean;
  /** For the ttsc suites only; Task 10 deletes it with them. `golem build` needs no tsconfig entry. */
  readonly ttscPlugin?: boolean;
  readonly linkTypescript?: boolean;
  /** For the ttsc suites only; Task 10 deletes it with them. */
  readonly linkTtsc?: boolean;
  readonly linkWorkspaceNodeModules?: boolean;
  readonly packages?: Readonly<Record<string, string>>;
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
  readonly include?: readonly string[];
}

export interface ModelProject {
  readonly root: string;
  readonly sourceRoot: string;
}

/** Create the standard temporary ESM consumer used by golem-model tests. */
export function createModelProject(t: TestContext, options: ModelProjectOptions): ModelProject {
  const root = createFixtureProject(t, options.prefix);
  const sourceRoot = path.join(root, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const packageManifest = {
    private: true,
    type: 'module',
    ...(options.name === null ? {} : {
      name: options.name ?? options.prefix.replace(/^golem-/, '').replace(/-+$/, ''),
    }),
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageManifest));

  if (options.linkWorkspaceNodeModules) {
    fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  } else {
    const packages: Record<string, string> = {
      '@exprtlabs/golem': path.join(workspace, 'packages/golem'),
      ...(options.linkTypescript ? { typescript: path.join(workspace, 'node_modules/typescript') } : {}),
      ...(options.linkTtsc ? { ttsc: path.join(workspace, 'node_modules/ttsc') } : {}),
      ...options.packages,
    };
    linkProjectPackages(root, packages);
  }

  const allowJs = options.allowJs ?? false;
  const compilerOptions: Record<string, unknown> = {
    strict: true,
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    skipLibCheck: true,
    outDir: options.outDir ?? 'build',
    rootDir: options.rootDir ?? 'src',
    ...(options.ttscPlugin ? { plugins: [{ transform: '@exprtlabs/golem/ttsc-plugin' }] } : {}),
    ...(allowJs ? { allowJs: true, checkJs: options.checkJs ?? false } : {}),
    ...options.compilerOptions,
  };
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions,
    include: options.include ?? ['src/**/*.ts', ...(allowJs ? ['src/**/*.js'] : [])],
  }));
  return { root, sourceRoot };
}

export function writeModelSources(
  sourceRoot: string,
  sources: Readonly<Record<string, string | SourceFragment>>,
): void {
  for (const [relative, source] of Object.entries(sources)) {
    const filename = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof source === 'string' ? source : source.text);
  }
}

/** The smallest golem.yaml `golem build` reads: it names the tsconfig beside it by default. */
export const MINIMAL_GOLEM_YAML = 'version: 1\nmodels:\n  root: .\n';

/**
 * Run `golem build` on the project: the original sources are checked and the rewritten ones emitted into its outDir. A project
 * without a golem.yaml gets the minimal one. A boolean compiler flag in `args` (`--noEmit`) builds an alternate config of the
 * project that extends its tsconfig with the flag on.
 */
export async function buildModelProject(
  root: string,
  args: readonly string[] = [],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const config = path.join(root, 'golem.yaml');
  if (!fs.existsSync(config)) fs.writeFileSync(config, MINIMAL_GOLEM_YAML);
  const flags = args.map((arg) => {
    if (!/^--[A-Za-z]+$/.test(arg)) throw new Error(`buildModelProject takes boolean compiler flags only, not ${arg}`);
    return arg.slice(2);
  });
  const project: string[] = [];
  if (flags.length > 0) {
    fs.writeFileSync(path.join(root, 'tsconfig.flags.json'), JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: Object.fromEntries(flags.map((flag) => [flag, true])),
    }));
    project.push('-p', path.join(root, 'tsconfig.flags.json'));
  }
  return command(root, process.execPath, [golem, 'build', '--config', config, ...project], options);
}

/** Compile with ttsc and the Go plugin: only the ttsc suites do, and Task 10 deletes this with them. */
export async function compileModelProjectWithTtsc(
  root: string,
  args: readonly string[] = [],
  options: CommandOptions = {},
): Promise<void> {
  await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
    ...args,
  ], options);
}
