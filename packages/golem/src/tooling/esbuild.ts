import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'esbuild';

import { applyRewrites, REWRITE_INDEX_PATH } from './rewrite.js';
import { BUNDLER_TYPESCRIPT_FILE, findRewriteIndex, NODE_MODULES, rewriteIndexRoot, withInlineSourceMap, type GolemBundlerOptions } from './rewrite-host.js';

/**
 * esbuild plugin that applies golem's rewrite index to TypeScript sources in memory, before esbuild strips their
 * types. The rewritten text carries its source map inline, which esbuild chains into the bundle's map. A TypeScript
 * file outside `node_modules` with no index fails the build instead of passing on unrewritten, and so does a file
 * that changed after `golem generate`; the error is located at the source file. The index is a watched file, so
 * esbuild's watch mode builds again when it changes or appears. This module imports neither TypeScript nor the checker.
 */
export type { GolemBundlerOptions };

export function golem(options: GolemBundlerOptions = {}): Plugin {
  return {
    name: 'golem',
    setup(build) {
      const root = options.root === undefined ? undefined : path.resolve(build.initialOptions.absWorkingDir ?? process.cwd(), options.root);
      build.onLoad({ filter: BUNDLER_TYPESCRIPT_FILE, namespace: 'file' }, async ({ path: file }) => {
        if (NODE_MODULES.test(file)) return undefined;
        const indexFile = path.join(rewriteIndexRoot(file, root), REWRITE_INDEX_PATH);
        try {
          const { index, relative } = findRewriteIndex(file, root);
          const applied = applyRewrites(relative, await readFile(file, 'utf8'), index);
          // A file the index does not list is left to the loaders after this one, which see it as they would without golem.
          if (!applied) return undefined;
          // Any listed file puts the index in esbuild's watch set.
          return { contents: withInlineSourceMap(applied.code, applied.map, file), loader: file.endsWith('.tsx') ? 'tsx' : 'ts', watchFiles: [indexFile] };
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          // The expected index is watched too, so `golem generate` afterwards builds again.
          return { errors: [{ text: error.message, location: { file } }], watchFiles: [indexFile] };
        }
      });
    },
  };
}
