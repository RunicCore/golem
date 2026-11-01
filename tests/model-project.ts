import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { command, golem, type CommandOptions, type CommandResult } from './support/process.js';
import {
  createFixtureProject,
  linkProjectPackages,
  listProjectDependencies,
  type FixtureScope,
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
  readonly linkTypescript?: boolean;
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
export function createModelProject(t: FixtureScope, options: ModelProjectOptions): ModelProject {
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
  // The project lists the golem packages it links, golem-model for its `model:` block among them.
  const golemPackages = new Set(['@exprtlabs/golem', '@exprtlabs/golem-model', ...Object.keys(options.packages ?? {}).filter((name) => name.startsWith('@exprtlabs/'))]);
  listProjectDependencies(root, [...golemPackages]);

  if (options.linkWorkspaceNodeModules) {
    fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  } else {
    const packages: Record<string, string> = {
      '@exprtlabs/golem': path.join(workspace, 'packages/golem'),
      '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model'),
      ...(options.linkTypescript ? { typescript: path.join(workspace, 'node_modules/typescript') } : {}),
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
export const MINIMAL_GOLEM_YAML = 'version: 1\nmodel: {}\n';

/** The golem.yaml of a project whose models job generates with `profile`: the profile its own `generate` calls used, so a build regenerates the same files. `exact` is the root default for the `exact` model option, not a profile key. */
export function writeModelGolemYaml(root: string, profile: Readonly<{ mobx?: boolean; validation?: boolean | 'sanity'; allowAny?: boolean; exact?: boolean }>): void {
  const keys = Object.entries(profile).filter(([key]) => key !== 'mobx').map(([key, value]) => `${key}: ${String(value)}\n`).join('');
  // The test-only switch `mobx` turns on the mobx extension of the openapi-ts block, a block that holds no SDK.
  const extension = profile.mobx ? 'openapi-ts:\n  extensions:\n    mobx: {}\n' : '';
  if (profile.mobx) {
    if (!fs.lstatSync(path.join(root, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink()) linkProjectPackages(root, { '@exprtlabs/golem-openapi-ts': path.join(workspace, 'packages/golem-openapi-ts') });
    listProjectDependencies(root, ['@exprtlabs/golem-openapi-ts']);
  }
  fs.writeFileSync(path.join(root, 'golem.yaml'), `version: 1\n${keys}${extension}model: {}\n`);
}

/** Write the project's golem.yaml for `profile` and run `golem build` on it. */
export async function buildModelProjectWith(root: string, profile: Parameters<typeof writeModelGolemYaml>[1]): Promise<CommandResult> {
  writeModelGolemYaml(root, profile);
  return buildModelProject(root);
}

/**
 * The files the project's models job wrote, as the golem.yaml's inventory records them: what a test would read from the result of its
 * own `generate` call if it generated in process. A test that builds generates once, in the build, and reads its output here.
 */
export function generatedModelFiles(root: string): readonly { readonly path: string; readonly content: string }[] {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, '.golem/outputs.json'), 'utf8')) as { readonly files: Readonly<Record<string, unknown>> };
  return Object.keys(inventory.files).sort().map((key) => {
    const filename = path.join(root, key);
    return { path: filename, content: fs.readFileSync(filename, 'utf8') };
  });
}

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
  // The build runs the models job, which the project installs and lists; a project that links the workspace's node_modules has it.
  if (!fs.lstatSync(path.join(root, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink()) {
    linkProjectPackages(root, { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') });
  }
  listProjectDependencies(root, ['@exprtlabs/golem-model']);
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
