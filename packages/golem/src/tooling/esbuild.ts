import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'esbuild';

import { applyRewrites, REWRITE_INDEX_PATH } from './rewrite.js';
import { BUNDLER_TYPESCRIPT_FILE, findRewriteIndex, NODE_MODULES, withInlineSourceMap, type GolemBundlerOptions } from './rewrite-host.js';

/**
 * esbuild plugin that applies golem's rewrite index to TypeScript sources in memory, before esbuild strips their
 * types. The rewritten text carries its source map inline, which esbuild chains into the bundle's map. A TypeScript
 * file outside `node_modules` with no index fails the build instead of passing on unrewritten, and so does a file
 * that changed after `golem generate`; the error is located at the source file. The index is a watched file, so
 * esbuild's watch mode builds again when it changes. This module imports neither TypeScript nor the checker.
 */
export type { GolemBundlerOptions };

export function golem(options: GolemBundlerOptions = {}): Plugin {
  return {
    name: 'golem',
    setup(build) {
      const root = options.root === undefined ? undefined : path.resolve(build.initialOptions.absWorkingDir ?? process.cwd(), options.root);
      build.onLoad({ filter: BUNDLER_TYPESCRIPT_FILE, namespace: 'file' }, async ({ path: file }) => {
        if (NODE_MODULES.test(file)) return undefined;
        const loader = file.endsWith('.tsx') ? 'tsx' : 'ts';
        let indexFile: string | undefined;
        try {
          const { root: indexRoot, index, relative } = findRewriteIndex(file, root);
          indexFile = path.join(indexRoot, REWRITE_INDEX_PATH);
          const text = await readFile(file, 'utf8');
          const applied = applyRewrites(relative, text, index);
          // A file the index does not list goes on as it is, still under the index's watch: the index may list it next.
          return { contents: applied ? withInlineSourceMap(applied.code, applied.map, file) : text, loader, watchFiles: [indexFile] };
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return { errors: [{ text: error.message, location: { file } }], ...(indexFile === undefined ? {} : { watchFiles: [indexFile] }) };
        }
      });
    },
  };
}
