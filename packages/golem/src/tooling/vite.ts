import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

import { applyRewrites, GolemRewriteMalformedIndexError, REWRITE_INDEX_PATH, type RewriteIndex } from './rewrite.js';
import { BUNDLER_TYPESCRIPT_FILE, findRewriteIndex, NODE_MODULES, rewriteIndexOf, rewriteIndexRoot, type GolemBundlerOptions } from './rewrite-host.js';

/**
 * Vite plugin that applies golem's rewrite index to TypeScript sources in memory, before Vite strips their types.
 * Put it first in `plugins`: it runs `pre` and must see the file text as it is on disk. A TypeScript file outside
 * `node_modules` with no index fails the build instead of passing on unrewritten, and so does a file that changed
 * after `golem generate`. An id with a query, such as `?raw`, is not the file's own text and passes through. The dev
 * server watches every index it used and, when one changes, transforms again only the modules whose entry changed.
 * This module imports neither TypeScript nor the checker.
 */
export type { GolemBundlerOptions };

/**
 * What the dev server last transformed against: each listed file's whole entry with the index's golem version, by its
 * path from the index's root. An entry's edits depend on more than the file's own text, so an unchanged sha256 does
 * not mean an unchanged rewrite. `undefined` is an index that is missing or unreadable.
 */
type IndexEntries = ReadonlyMap<string, string> | undefined;

function entriesOf(index: RewriteIndex | undefined): IndexEntries {
  if (index === undefined) return undefined;
  return new Map(Object.entries(index.files).map(([file, entry]) => [file, `${index.golem}\n${JSON.stringify(entry)}`]));
}

const posix = (file: string): string => file.split(path.sep).join('/');

export function golem(options: GolemBundlerOptions = {}): Plugin {
  let root: string | undefined;
  let server: ViteDevServer | undefined;
  // Each root whose index a transform used, or looked for, with the entries the dev server last transformed against.
  const roots = new Map<string, IndexEntries>();
  // Roots whose index was unreadable at the last event: pages that showed its error reload once it reads again.
  const unreadable = new Set<string>();

  /** Records `indexRoot` and watches its index, which may sit above Vite's root, where Vite does not watch. */
  const watchIndex = (indexRoot: string, index: RewriteIndex | undefined): void => {
    if (!server || roots.has(indexRoot)) return;
    roots.set(indexRoot, entriesOf(index));
    server.watcher.add(path.join(indexRoot, REWRITE_INDEX_PATH));
  };

  /** Invalidates the modules whose entry in `indexRoot`'s index was added, removed or changed since the last look. */
  const indexChanged = (indexRoot: string): void => {
    if (!server) return;
    let current: IndexEntries;
    try {
      current = entriesOf(rewriteIndexOf(indexRoot));
    } catch (error) {
      // A malformed index is a write in progress; the next change event reads the finished file.
      if (!(error instanceof GolemRewriteMalformedIndexError)) throw error;
      unreadable.add(indexRoot);
      return;
    }
    const previous = roots.get(indexRoot);
    roots.set(indexRoot, current);
    let invalidated = 0;
    for (const file of new Set([...(previous?.keys() ?? []), ...(current?.keys() ?? [])])) {
      if (previous?.get(file) === current?.get(file)) continue;
      for (const module of server.moduleGraph.getModulesByFile(posix(path.join(indexRoot, file))) ?? []) {
        server.moduleGraph.invalidateModule(module);
        invalidated += 1;
      }
    }
    // A module that failed for want of a readable index loads again once there is one, even if the index lists nothing.
    const recovered = unreadable.delete(indexRoot) || (previous === undefined && current !== undefined);
    if (invalidated > 0 || recovered) server.ws.send({ type: 'full-reload' });
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
      let found: ReturnType<typeof findRewriteIndex>;
      try {
        found = findRewriteIndex(id, root);
      } catch (error) {
        // The session recovers when the index appears or is repaired.
        watchIndex(rewriteIndexRoot(id, root), undefined);
        throw error;
      }
      const { root: indexRoot, index, relative } = found;
      watchIndex(indexRoot, index);
      const applied = applyRewrites(relative, code, index);
      if (!applied) return undefined;
      const { map } = applied;
      // The map's source is the module's own file name, as in the other hosts: a served map resolves `sources` against the module's URL.
      return { code: applied.code, map: { version: 3, sources: [path.basename(id)], sourcesContent: [code], names: [...map.names], mappings: map.mappings } };
    },
  };
}
