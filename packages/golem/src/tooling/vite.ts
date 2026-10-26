import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

import { isGeneratedModelFile } from './generated-paths.js';
import { BUNDLER_TYPESCRIPT_FILE, openRewriteProject, type GolemHostOptions, type RewriteProject } from './rewrite-host.js';
import { isInstalledFile } from './type-analysis/path-identity.js';

/**
 * Vite plugin that scans each TypeScript module with the project's own TypeScript, against the golem.yaml named by
 * `config`, `GOLEM_CONFIG` or `./golem.yaml` in Vite's root, and applies the rewrite in memory before Vite strips the
 * types. Put it first in `plugins`: it runs `pre` and must see the file text as it is on disk. A module the scan cannot
 * rewrite fails with its file and line. An id with a query, such as `?raw`, is not the file's own text and passes
 * through, and so do `node_modules`. The first TypeScript module loads the compiler. The dev server watches the files
 * each rewrite depends on, and a build adds them to its watch set. When one changes, or a generated model file of the project does, the project scans again
 * and only the modules whose rewrite came out different, or that failed, are transformed again.
 */
export type { GolemHostOptions };

/** The generated files of one watch run arrive as separate file events; the events inside this window share one reload. */
const RELOAD_WINDOW_MS = 100;

const posix = (file: string): string => file.split(path.sep).join('/');

export function golem(options: GolemHostOptions = {}): Plugin {
  let root = process.cwd();
  let server: ViteDevServer | undefined;
  let opening: Promise<RewriteProject> | undefined;
  let project: RewriteProject | undefined;
  /** The files each module's rewrite depends on, and the modules that depend on each file. */
  const dependenciesOf = new Map<string, readonly string[]>();
  const dependents = new Map<string, Set<string>>();
  /** What each module's last rewrite came to, to tell a dependency change that alters the module from one that does not. */
  const digests = new Map<string, string>();
  /** Modules whose scan failed: a regenerated model may fix them. */
  const failed = new Set<string>();
  let reloadTimer: NodeJS.Timeout | undefined;

  const open = (): Promise<RewriteProject> => {
    opening ??= openRewriteProject({ cwd: root, ...options }).then((opened) => {
      project = opened;
      return opened;
    }, (error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };

  const track = (id: string, dependencies: readonly string[]): void => {
    for (const dependency of dependenciesOf.get(id) ?? []) dependents.get(dependency)?.delete(id);
    dependenciesOf.set(id, dependencies);
    for (const dependency of dependencies) {
      const ids = dependents.get(dependency) ?? new Set<string>();
      ids.add(id);
      dependents.set(dependency, ids);
    }
  };

  const digest = (code: string): string => createHash('sha256').update(code).digest('hex');

  /**
   * Whether `id` still rewrites to what its last transform gave, scanning it again with the project's current state.
   * A module that does not is expected to transform again, so the digest moves to the new rewrite.
   */
  const rewritesAsBefore = (id: string, rewriting: RewriteProject): boolean => {
    try {
      const again = rewriting.rewrite(id, readFileSync(id, 'utf8'));
      const current = again === undefined ? undefined : digest(again.code);
      if (current === digests.get(id)) return true;
      if (current === undefined) digests.delete(id); else digests.set(id, current);
      return false;
    } catch {
      // The next transform fails again with the message.
      return false;
    }
  };

  /** Sends one full reload for the invalidations of the events within the window that this call opens. */
  const reloadSoon = (): void => {
    reloadTimer ??= setTimeout(() => {
      reloadTimer = undefined;
      server?.ws.send({ type: 'full-reload' });
    }, RELOAD_WINDOW_MS);
    reloadTimer.unref();
  };

  /** A rewrite's dependency or a generated model file of the project changed: tell the session, then invalidate what depended on it. */
  const fileChanged = (changed: string): void => {
    if (!server || !project) return;
    const file = path.resolve(changed);
    const depending = dependents.get(file);
    const generated = isGeneratedModelFile(file);
    if (!depending && !generated) return;
    project.changed([file]);
    const ids = new Set([...(depending ?? []), ...(generated ? failed : [])]);
    let invalidated = 0;
    for (const id of ids) {
      if (!failed.has(id) && rewritesAsBefore(id, project)) continue;
      failed.delete(id);
      for (const module of server.moduleGraph.getModulesByFile(posix(id)) ?? []) {
        server.moduleGraph.invalidateModule(module);
        invalidated += 1;
      }
    }
    if (invalidated > 0) reloadSoon();
  };

  return {
    name: 'golem',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    configureServer(devServer) {
      server = devServer;
      for (const event of ['add', 'change', 'unlink'] as const) devServer.watcher.on(event, fileChanged);
    },
    async transform(code, id) {
      if (id.includes('?') || id.startsWith('\0') || !BUNDLER_TYPESCRIPT_FILE.test(id) || isInstalledFile(id)) return undefined;
      const rewriting = await open();
      let rewritten: ReturnType<RewriteProject['rewrite']>;
      try {
        rewritten = rewriting.rewrite(id, code);
      } catch (error) {
        failed.add(id);
        track(id, []);
        throw error;
      }
      failed.delete(id);
      track(id, rewritten?.dependencies ?? []);
      if (!rewritten) return undefined;
      digests.set(id, digest(rewritten.code));
      // The dev server watches a dependency without importing it: a module that imports the file would be transformed again with every other importer when it changes, whether its rewrite changed or not.
      if (server) server.watcher.add([...rewritten.dependencies]);
      else for (const dependency of rewritten.dependencies) this.addWatchFile(dependency);
      const { map } = rewritten;
      // The map's source is the module's own file name: a served map resolves `sources` against the module's URL.
      return { code: rewritten.code, map: { version: 3, sources: [path.basename(id)], sourcesContent: [code], names: [...map.names], mappings: map.mappings } };
    },
    closeBundle() {
      clearTimeout(reloadTimer);
      reloadTimer = undefined;
      const closing = opening;
      opening = undefined;
      project = undefined;
      void closing?.then((opened) => { opened.close(); }, () => undefined);
    },
  };
}
