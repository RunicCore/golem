import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

import { command, type CommandOptions } from './packed/helpers.js';
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
  readonly ttscPlugin?: boolean;
  readonly linkTypescript?: boolean;
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

/** Create the standard temporary ESM consumer used by model-codegen tests. */
export function createModelProject(t: TestContext, options: ModelProjectOptions): ModelProject {
  const root = createFixtureProject(t, options.prefix);
  const sourceRoot = path.join(root, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const packageManifest = {
    private: true,
    type: 'module',
    ...(options.name === null ? {} : {
      name: options.name ?? options.prefix.replace(/^runic-/, '').replace(/-+$/, ''),
    }),
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageManifest));

  if (options.linkWorkspaceNodeModules) {
    fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  } else {
    const packages: Record<string, string> = {
      '@exprtlabs/codegen': path.join(workspace, 'packages/codegen'),
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
    ...(options.ttscPlugin ? { plugins: [{ transform: '@exprtlabs/codegen/ttsc-plugin' }] } : {}),
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

export async function compileModelProject(
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
