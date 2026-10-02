import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'esbuild';

import { applyRewrites } from './rewrite.js';
import { BUNDLER_TYPESCRIPT_FILE, findRewriteIndex, NODE_MODULES, withInlineSourceMap, type GolemBundlerOptions } from './rewrite-host.js';

/**
 * esbuild plugin that applies golem's rewrite index to TypeScript sources in memory, before esbuild strips their
 * types. The rewritten text carries its source map inline, which esbuild chains into the bundle's map. A TypeScript
 * file outside `node_modules` with no index fails the build instead of passing on unrewritten, and so does a file
 * that changed after `golem generate`. This module imports neither TypeScript nor the checker.
 */
export type { GolemBundlerOptions };

export function golem(options: GolemBundlerOptions = {}): Plugin {
  const root = options.root === undefined ? undefined : path.resolve(options.root);
  return {
    name: 'golem',
    setup(build) {
      build.onLoad({ filter: BUNDLER_TYPESCRIPT_FILE, namespace: 'file' }, async ({ path: file }) => {
        if (NODE_MODULES.test(file)) return undefined;
        const { index, relative } = findRewriteIndex(file, root);
        const applied = applyRewrites(relative, await readFile(file, 'utf8'), index);
        if (!applied) return undefined;
        return { contents: withInlineSourceMap(applied.code, applied.map, file), loader: file.endsWith('.tsx') ? 'tsx' : 'ts' };
      });
    },
  };
}
