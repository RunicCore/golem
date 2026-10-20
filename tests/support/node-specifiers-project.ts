import fs from 'node:fs';
import path from 'node:path';
import { copyFixture, fixturePath, type FixtureScope } from '../fixture-project.js';
import { createModelProject } from '../model-project.js';

/** The fixture project of the Node-loadable import paths (tests/fixtures/node-specifiers): ESNext modules, Bundler resolution and the aliases `@lib/*` and `@ids` with no `baseUrl`. */
export const NODE_SPECIFIER_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  rewriteRelativeImportExtensions: true,
  resolveJsonModule: true,
  paths: { '@lib/*': ['./src/lib/*'], '@ids': ['./src/lib/ids'] },
} as const;

/**
 * An ESM project with the options above and the fixture's fake packages under node_modules. The fixture holds them under
 * `packages/`, because the repository ignores each `node_modules/` folder. The caller places the sources under `src/`.
 */
export function createNodeSpecifierProject(t: FixtureScope, options: { readonly prefix: string; readonly compilerOptions?: Readonly<Record<string, unknown>> }): string {
  const { root } = createModelProject(t, {
    prefix: options.prefix,
    name: 'node-specifiers',
    allowJs: true,
    linkTypescript: true,
    compilerOptions: { ...NODE_SPECIFIER_COMPILER_OPTIONS, ...options.compilerOptions },
  });
  const packages = fixturePath('node-specifiers/packages');
  for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
    const scoped = entry.name.startsWith('@');
    for (const name of scoped ? fs.readdirSync(path.join(packages, entry.name)).map(child => `${entry.name}/${child}`) : [entry.name]) {
      copyFixture(path.join(root, 'node_modules', name), `node-specifiers/packages/${name}`);
    }
  }
  return root;
}
