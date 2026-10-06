import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

import { BUNDLER_TYPESCRIPT_FILE, GolemHostError, LAYER_SPECIFIER, layerOf, NODE_MODULES, openRewriteProject, withInlineSourceMap, type GolemHostOptions, type RewriteProject } from './rewrite-host.js';

/**
 * esbuild plugin that scans each TypeScript source with the project's own TypeScript, against the golem.yaml named by
 * `config`, `GOLEM_CONFIG` or `./golem.yaml` in `absWorkingDir` (default: the current directory), and applies the
 * rewrite in memory before esbuild strips the types. The rewritten text carries its source map inline, which esbuild
 * chains into the bundle's map. A file the scan cannot rewrite is an error located at the file and line; a file with
 * no rewrite goes on to the plugins after this one, and a failed file watches the key tables `golem generate` writes. The first TypeScript file loads the compiler. The files a rewrite
 * depends on are watched, and each rebuild scans the files it loads again.
 */
export type { GolemHostOptions };

export function golem(options: GolemHostOptions = {}): Plugin {
  return {
    name: 'golem',
    setup(build) {
      const cwd = build.initialOptions.absWorkingDir ?? process.cwd();
      let opening: Promise<RewriteProject> | undefined;
      let project: RewriteProject | undefined;
      let builds = 0;
      /** Every file a build loaded or depended on: esbuild does not say which changed, so a rebuild tells the session about all of them. */
      const touched = new Set<string>();

      const open = (): Promise<RewriteProject> => {
        opening ??= openRewriteProject({ cwd, ...options }).then((opened) => {
          project = opened;
          return opened;
        }, (error: unknown) => {
          opening = undefined;
          throw error;
        });
        return opening;
      };

      build.onStart(() => {
        builds += 1;
        if (builds > 1) project?.changed([...touched]);
      });
      build.onDispose(() => {
        const closing = opening;
        opening = undefined;
        project = undefined;
        void closing?.then((opened) => { opened.close(); }, () => undefined);
      });
      build.onResolve({ filter: /^#golem-models$/ }, async ({ importer }) => {
        try {
          return { path: layerOf(await open(), importer) };
        } catch (error) {
          if (!(error instanceof GolemHostError)) throw error;
          return { errors: [{ text: error.message, location: { file: importer } }] };
        }
      });
      build.onLoad({ filter: BUNDLER_TYPESCRIPT_FILE, namespace: 'file' }, async ({ path: file }) => {
        if (NODE_MODULES.test(file)) return undefined;
        try {
          const rewriting = await open();
          touched.add(file);
          const rewritten = rewriting.rewrite(file, await readFile(file, 'utf8'));
          // A file with no rewrite is left to the loaders after this one, which see it as they would without golem.
          if (!rewritten) return undefined;
          for (const dependency of rewritten.dependencies) touched.add(dependency);
          return { contents: withInlineSourceMap(rewritten.code, rewritten.map, file), loader: file.endsWith('.tsx') ? 'tsx' : 'ts', watchFiles: [...rewritten.dependencies] };
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const location = error instanceof GolemHostError ? error.location : undefined;
          // A failed rewrite lists no dependencies, so the key tables golem generate writes are watched, though they may not exist yet.
          const watchFiles = project?.expectedGenerated ?? [];
          for (const generated of watchFiles) touched.add(generated);
          return { errors: [{ text: error.message, location: { file: location?.file ?? file, ...(location?.line === undefined ? {} : { line: location.line }) } }], watchFiles: [...watchFiles] };
        }
      });
    },
  };
}
