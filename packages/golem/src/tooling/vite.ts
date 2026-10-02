import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

import { applyRewrites, REWRITE_INDEX_PATH, type RewriteIndex } from './rewrite.js';
import { BUNDLER_TYPESCRIPT_FILE, findRewriteIndex, NODE_MODULES, rewriteIndexOf, type GolemBundlerOptions } from './rewrite-host.js';

/**
 * Vite plugin that applies golem's rewrite index to TypeScript sources in memory, before Vite strips their types.
 * Put it first in `plugins`: it runs `pre` and must see the file text as it is on disk. A TypeScript file outside
 * `node_modules` with no index fails the build instead of passing on unrewritten, and so does a file that changed
 * after `golem generate`. An id with a query, such as `?raw`, is not the file's own text and passes through. The dev
 * server watches every index it used and, when one changes, transforms again only the modules whose entry changed.
 * This module imports neither TypeScript nor the checker.
 */
export type { GolemBundlerOptions };

/** The sha256 of each file an index lists, by its path from the index's root. */
type IndexShas = ReadonlyMap<string, string>;

function shasOf(index: RewriteIndex | undefined): IndexShas {
  return new Map(Object.entries(index?.files ?? {}).map(([file, entry]) => [file, entry.sha256]));
}

export function golem(options: GolemBundlerOptions = {}): Plugin {
  let root: string | undefined;
  let server: ViteDevServer | undefined;
  // Each root whose index a transform used, with the entries the dev server last transformed against.
  const roots = new Map<string, IndexShas>();

  /** Invalidates the modules whose entry in `root`'s index was added, removed or changed since the last look. */
  const indexChanged = (indexRoot: string): void => {
    if (!server) return;
    let current: IndexShas;
    try {
      current = shasOf(rewriteIndexOf(indexRoot));
    } catch {
      // A malformed index is a write in progress; the next change event reads the finished file.
      return;
    }
    const previous = roots.get(indexRoot) ?? new Map<string, string>();
    roots.set(indexRoot, current);
    let invalidated = 0;
    for (const file of new Set([...previous.keys(), ...current.keys()])) {
      if (previous.get(file) === current.get(file)) continue;
      for (const module of server.moduleGraph.getModulesByFile(path.join(indexRoot, file)) ?? []) {
        server.moduleGraph.invalidateModule(module);
        invalidated += 1;
      }
    }
    if (invalidated > 0) server.ws.send({ type: 'full-reload' });
  };

  return {
    name: 'golem',
    enforce: 'pre',
    configResolved(config) {
      if (options.root !== undefined) root = path.resolve(config.root, options.root);
    },
    configureServer(devServer) {
      server = devServer;
      const handle = (changed: string): void => {
        for (const indexRoot of roots.keys()) {
          if (path.resolve(changed) === path.join(indexRoot, REWRITE_INDEX_PATH)) indexChanged(indexRoot);
        }
      };
      for (const event of ['add', 'change', 'unlink'] as const) devServer.watcher.on(event, handle);
    },
    transform(code, id) {
      if (id.includes('?') || id.startsWith('\0') || !BUNDLER_TYPESCRIPT_FILE.test(id) || NODE_MODULES.test(id)) return undefined;
      const { root: indexRoot, index, relative } = findRewriteIndex(id, root);
      if (server && !roots.has(indexRoot)) {
        // The index may sit above Vite's root, where Vite does not watch.
        roots.set(indexRoot, shasOf(index));
        server.watcher.add(path.join(indexRoot, REWRITE_INDEX_PATH));
      }
      const applied = applyRewrites(relative, code, index);
      if (!applied) return undefined;
      const { map } = applied;
      // The map's source is the module's own file name, as in the other hosts: a served map resolves `sources` against the module's URL.
      return { code: applied.code, map: { version: 3, sources: [path.basename(id)], sourcesContent: [code], names: [...map.names], mappings: map.mappings } };
    },
  };
}
