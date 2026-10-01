import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { listPublicSourceFiles, publicContentOptions, scanPublicContent } from './public-source.js';
import { SOURCE_EXAMPLES } from './maintained-examples.js';
const packageSnippetSources = new Set([
  'packages/golem/src/nest.ts',
]);
/** The benchmark page shows the fixtures it times; they are in the public source inventory. */
const benchmarkSnippetPrefix = 'scripts/benchmark/fixtures/';

/**
 * Region marker forms VitePress accepts in `<<<` includes. VitePress renders the whole
 * file when a region is missing, so the docs check needs the same forms to catch it.
 */
const regionMarkers: readonly RegExp[] = [
  /^\/\/ ?#?((?:end)?region) ([\w*-]+)$/,
  /^\/\* ?#((?:end)?region) ([\w*-]+) ?\*\/$/,
  /^#pragma ((?:end)?region) ([\w*-]+)$/,
  /^<!-- #?((?:end)?region) ([\w*-]+) -->$/,
  /^#((?:End )Region) ([\w*-]+)$/,
  /^::#((?:end)region) ([\w*-]+)$/,
  /^# ?((?:end)?region) ([\w*-]+)$/,
];

/** True when the text opens and closes the named region with one marker form. */
function hasRegion(text: string, name: string): boolean {
  const marks = (line: string, marker: RegExp, end: boolean): boolean => {
    const [, tag, found] = marker.exec(line.trim()) ?? [];
    return found === name && new RegExp(end ? '^[Ee]nd ?[rR]egion$' : '^[rR]egion$').test(tag ?? '');
  };
  let open: RegExp | undefined;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!open) open = regionMarkers.find(marker => marks(line, marker, false));
    else if (marks(line, open, true)) return true;
  }
  return false;
}

/** Complete source for the maintained files embedded in documentation snippets. */
export function docExampleSources(root: string): readonly { source: string }[] {
  const allowed = new Set(listPublicSourceFiles(root));
  const sources = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith('.md')) {
        for (const match of readFileSync(filename, 'utf8').matchAll(/^<<<\s+(\S+)/gm)) {
          const target = match[1].replace(/[#\{].*$/, '');
          const absolute = target.startsWith('@/')
            ? path.resolve(root, 'docs', target.slice(2))
            : path.resolve(path.dirname(filename), target);
          const relative = path.relative(root, absolute).split(path.sep).join('/');
          if ((!relative.startsWith('examples/') && !relative.startsWith(benchmarkSnippetPrefix) && !packageSnippetSources.has(relative)) || !allowed.has(relative)) {
            throw new Error(`Documentation source is outside the public snippet inventory: ${path.relative(root, filename)} -> ${relative}`);
          }
          const region = /^[^#{]*#([\w-]+)/.exec(match[1])?.[1];
          if (region && !hasRegion(readFileSync(absolute, 'utf8'), region)) {
            throw new Error(`Documentation region is missing: ${path.relative(root, filename)} -> ${relative}#${region}`);
          }
          sources.add(relative);
        }
      }
    }
  };
  visit(path.join(root, 'docs'));
  return [...sources].sort().map(source => ({ source }));
}

/** Stage reviewed static assets and validate source embedded in the docs. */
export function stageDocsPublicAssets(root: string): string {
  const publicDirectory = path.join(root, '.cache/docs-public');
  rmSync(publicDirectory, { recursive: true, force: true });
  mkdirSync(publicDirectory, { recursive: true });

  // Scan all documentation includes so every embedded source remains inside
  // the reviewed public snippet inventory. The files are rendered in-page;
  // repository examples remain the source of truth.
  docExampleSources(root);
  const options = publicContentOptions(root);

  // VitePress serves this staged directory, including reviewed static artwork.
  const staticAssets = listPublicSourceFiles(root).filter(file => file.startsWith('docs/public/'));
  const assetIssues = scanPublicContent(root, staticAssets, options);
  if (assetIssues.length) throw new Error(assetIssues.map(issue => `${issue.category}: ${issue.path}`).join('\n'));
  for (const file of staticAssets) {
    const output = path.join(publicDirectory, file.slice('docs/public/'.length));
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(path.join(root, file), output);
  }

  const publicSources = listPublicSourceFiles(root);
  for (const example of SOURCE_EXAMPLES) {
    const prefix = `examples/${example}/`;
    const files = publicSources.filter((file) => file.startsWith(prefix));
    if (!files.includes(`${prefix}package.json`)) {
      throw new Error(`${example} example is missing its package manifest`);
    }
    const issues = scanPublicContent(root, files, options);
    if (issues.length) throw new Error(issues.map((issue) => `${issue.category}: ${issue.path}`).join('\n'));
  }

  return publicDirectory;
}
