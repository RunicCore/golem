import path from 'node:path';
import type { Plugin } from 'vite';

import { applyRewrites, REWRITE_INDEX_PATH } from './rewrite.js';
import { BUNDLER_TYPESCRIPT_FILE, findRewriteIndex, NODE_MODULES, type GolemBundlerOptions } from './rewrite-host.js';

/**
 * Vite plugin that applies golem's rewrite index to TypeScript sources in memory, before Vite strips their types.
 * Put it first in `plugins`: it runs `pre` and must see the file text as it is on disk. A TypeScript file outside
 * `node_modules` with no index fails the build instead of passing on unrewritten, and so does a file that changed
 * after `golem generate`. An id with a query, such as `?raw`, is not the file's own text and passes through. This
 * module imports neither TypeScript nor the checker.
 */
export type { GolemBundlerOptions };

export function golem(options: GolemBundlerOptions = {}): Plugin {
  let root = options.root === undefined ? undefined : path.resolve(options.root);
  return {
    name: 'golem',
    enforce: 'pre',
    configResolved(config) {
      if (options.root !== undefined) root = path.resolve(config.root, options.root);
    },
    configureServer(server) {
      // The index is read again whenever its file changes; modules Vite already transformed need transforming again.
      // Vite watches its own root; an index above it needs adding.
      const indexFile = path.join(root ?? server.config.root, REWRITE_INDEX_PATH);
      if (path.relative(server.config.root, indexFile).startsWith('..')) server.watcher.add(indexFile);
      const reload = (changed: string): void => {
        if (path.resolve(changed) !== indexFile) return;
        server.moduleGraph.invalidateAll();
        server.ws.send({ type: 'full-reload' });
      };
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, reload);
    },
    transform(code, id) {
      if (id.includes('?') || id.startsWith('\0') || !BUNDLER_TYPESCRIPT_FILE.test(id) || NODE_MODULES.test(id)) return undefined;
      const { index, relative } = findRewriteIndex(id, root);
      const applied = applyRewrites(relative, code, index);
      if (!applied) return undefined;
      const { map } = applied;
      // The map's source is the module's own file name, as in the other hosts: a served map resolves `sources` against the module's URL.
      return { code: applied.code, map: { version: 3, sources: [path.basename(id)], sourcesContent: [code], names: [...map.names], mappings: map.mappings } };
    },
  };
}
