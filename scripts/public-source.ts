import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface PublicContentIssue { readonly path: string; readonly category: string }
export interface PublicContentOptions {
  readonly deniedText?: readonly string[];
  readonly artifact?: 'source' | 'site' | 'package';
}

const excludedDirectories = new Set([
  '.git', '.private', '.cache', '.build', 'node_modules', 'dist', 'coverage',
  '.agents', '.beads', '.obs', '.cursor', '.codex', '.serena', '.idea', '.vscode',
]);
const rootFiles = new Set([
  'README.md', 'CHANGELOG.md', 'LICENSE',
  'package.json', 'package-lock.json', '.gitignore',
]);
const packageFolders = new Set(['golem', 'golem-model', 'golem-openapi', 'golem-ts-openapi']);
const packageFiles = new Set(['package.json', 'README.md', 'LICENSE', 'MATRIX.md', 'THIRD_PARTY_NOTICES.md']);
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml', '.txt', '.css', '.html', '.svg', '.vue', '.map', '.go', '.mod', '.sum', '.work']);

function portable(filename: string): string { return filename.split(path.sep).join('/'); }
function forbiddenPath(filename: string, packaged = false): boolean {
  const parts = portable(filename).split('/');
  const name = parts.at(-1) ?? '';
  return parts.some((part, index) => excludedDirectories.has(part) && !(packaged && index === 0 && part === 'dist'))
    || /(?:^|\/)\.vitepress\/(?:cache|dist|\.temp)(?:\/|$)/.test(portable(filename))
    || /^(?:AGENTS(?:\.override)?\.md|CLAUDE\.md|CODE_REVIEW\.md|VERIFICATION\.md|\.DS_Store|\.npmrc)$/.test(name)
    || /^\.env(?:\.|$)/.test(name)
    || /\.(?:log|jsonl|tgz|tsbuildinfo|pem|key)$/i.test(name);
}

function allowedSource(filename: string): boolean {
  const parts = portable(filename).split('/');
  const [top, folder, ...rest] = parts;
  if (parts.length === 1) return rootFiles.has(top) || /^tsconfig(?:\.[\w-]+)?\.json$/.test(top);
  if (top === 'packages') {
    if (!packageFolders.has(folder)) return false;
    return rest[0] === 'src' || rest[0] === 'compliance' || rest[0] === 'plugin' || rest[0] === 'LICENSES'
      || (rest.length === 1 && (packageFiles.has(rest[0]) || rest[0] === 'ttsc-plugin.cjs'
        || /^tsconfig(?:\.[\w-]+)?\.json$/.test(rest[0])));
  }
  if (top === '.github') return folder === 'workflows' && /\.ya?ml$/.test(filename);
  return ['scripts', 'tests', 'examples', 'docs'].includes(top);
}

function filesIn(root: string, sourceOnly: boolean): string[] {
  const canonicalRoot = fs.realpathSync(root);
  const result: string[] = [];
  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = portable(path.relative(canonicalRoot, absolute));
      if (sourceOnly && forbiddenPath(relative)) continue;
      if (sourceOnly && !relative.includes('/') && entry.isDirectory()
        && !['packages', 'scripts', 'tests', 'examples', 'docs', '.github'].includes(relative)) continue;
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(absolute);
        const target = path.relative(canonicalRoot, resolved);
        if (target === '..' || target.startsWith(`..${path.sep}`) || path.isAbsolute(target)) {
          throw new Error(`Public source rejected: external symbolic link at ${relative}`);
        }
        throw new Error(`Public source rejected: symbolic link at ${relative}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && (!sourceOnly || allowedSource(relative))) result.push(relative);
    }
  }
  visit(canonicalRoot);
  return result.sort();
}

export function listPublicSourceFiles(root: string): string[] { return filesIn(root, true); }

const contentRules: readonly [string, RegExp][] = [
  ['machine-path', /(?:^|[\s"'`(])(?:\/Users\/[^\/\s"']+\/|\/home\/[^\/\s"']+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/m],
  ['temporary-machine-path', /\/var\/folders\/[a-zA-Z0-9_/.-]+/],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['access-token', /\b(?:gh[pousr]_[A-Za-z0-9]{32,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-proj-[A-Za-z0-9_-]{40,})\b/],
  ['execution-record', /\b(?:session|thread|operation)[ _-]?(?:id|identifier)\s*[:=]\s*["']?[a-f0-9]{8}-[a-f0-9-]{27,}/i],
  ['internal-review', /\bindependent\s+(?:PO|QA)\s*(?:acceptance|:\s*(?:ACCEPT|PASS))/i],
];

export function scanPublicContent(root: string, files?: readonly string[], options: PublicContentOptions = {}): PublicContentIssue[] {
  const issues: PublicContentIssue[] = [];
  const absoluteRoot = fs.realpathSync(root);
  for (const filename of files ?? filesIn(root, false)) {
    const absolute = path.resolve(absoluteRoot, filename);
    const relative = portable(path.relative(absoluteRoot, absolute));
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      issues.push({ path: '[outside root]', category: 'path-traversal' });
      continue;
    }
    if (forbiddenPath(relative, options.artifact === 'package')) issues.push({ path: relative, category: 'private-artifact' });
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) { issues.push({ path: relative, category: 'symbolic-link' }); continue; }
    const resolvedRelative = path.relative(absoluteRoot, fs.realpathSync(absolute));
    if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) {
      issues.push({ path: relative, category: 'external-symbolic-link' });
      continue;
    }
    if (!stat.isFile()) continue;
    if (!textExtensions.has(path.extname(relative)) && !rootFiles.has(path.basename(relative))) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    for (const [category, pattern] of contentRules) {
      if (pattern.test(text)) issues.push({ path: relative, category });
    }
    if (options.deniedText?.some(value => value.length > 0 && text.includes(value))) {
      issues.push({ path: relative, category: 'private-reference' });
    }
  }
  return issues;
}

/** Environment variable with extra denied text, one entry per line (CI secret). */
export const DENIED_TEXT_VARIABLE = 'PUBLIC_CONTENT_DENIED_TEXT';
/** Set to `1` to fail when no denied text is configured. */
export const REQUIRE_DENIED_TEXT_VARIABLE = 'PUBLIC_CONTENT_REQUIRE_DENIED_TEXT';

/** Denied text from `.private/public-content.json` and the environment. Values never appear in reports. */
export function publicContentOptions(root: string, env: NodeJS.ProcessEnv = process.env): PublicContentOptions {
  const deniedText: string[] = [];
  const filename = path.join(root, '.private', 'public-content.json');
  if (fs.existsSync(filename)) {
    const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!value || typeof value !== 'object' || !('deniedText' in value)
      || !Array.isArray(value.deniedText) || !value.deniedText.every((item: unknown) => typeof item === 'string')) {
      throw new Error('Invalid local public-content rules.');
    }
    deniedText.push(...value.deniedText);
  }
  deniedText.push(...(env[DENIED_TEXT_VARIABLE] ?? '').split(/\r?\n/).map(value => value.trim()));
  const configured = deniedText.filter(value => value.length > 0);
  if (!configured.length && env[REQUIRE_DENIED_TEXT_VARIABLE] === '1') {
    throw new Error(`No denied text is configured; set ${DENIED_TEXT_VARIABLE} or add .private/public-content.json.`);
  }
  return configured.length ? { deniedText: configured } : {};
}

function rejectIssues(issues: readonly PublicContentIssue[]): void {
  if (issues.length) throw new Error(`Public content rejected:\n${issues.map(issue => `${issue.category}: ${issue.path}`).join('\n')}`);
}

function digestFiles(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const filename of files) hash.update(filename).update('\0').update(fs.readFileSync(path.join(root, filename))).update('\0');
  return hash.digest('hex');
}

// Public-source roots that npm pack never reads: the packages, root manifests,
// tsconfigs and scripts/verify-package.ts build the tarballs.
const PACK_UNREAD_ROOTS: readonly string[] = ['.github', 'docs', 'tests'];

/** Key of a packed set: the digest of the public source files the pack step can read. A test or docs edit keeps the set. */
export function packedSetDigest(root: string): string {
  const files = listPublicSourceFiles(root).filter(file => !PACK_UNREAD_ROOTS.includes(portable(file).split('/')[0]));
  return digestFiles(fs.realpathSync(root), files);
}

export function exportPublicSource(source: string, destination: string): { files: readonly string[]; digest: string } {
  const files = listPublicSourceFiles(source);
  rejectIssues(scanPublicContent(source, files, publicContentOptions(source)));
  const from = fs.realpathSync(source);
  const requested = path.resolve(destination);
  if (fs.existsSync(requested) && fs.lstatSync(requested).isSymbolicLink()) throw new Error('Public export destination must not be a symbolic link.');
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const to = path.join(fs.realpathSync(ancestor), path.relative(ancestor, requested));
  const requestedWithinSource = path.relative(from, requested);
  if (requestedWithinSource.split(path.sep)[0] === '.cache'
    && path.relative(from, to).split(path.sep)[0] !== '.cache') {
    throw new Error('Public export destination must not escape through symbolic links.');
  }
  const sourceFromDestination = path.relative(to, from);
  if (to === from || (!sourceFromDestination.startsWith(`..${path.sep}`) && sourceFromDestination !== '..' && !path.isAbsolute(sourceFromDestination))) {
    throw new Error('Public export destination must not contain the source.');
  }
  const withinSource = path.relative(from, to);
  if (!withinSource.startsWith(`..${path.sep}`) && withinSource !== '..' && !path.isAbsolute(withinSource)
    && withinSource.split(path.sep)[0] !== '.cache') {
    throw new Error('Public export inside the source must use the ignored cache directory.');
  }
  if (fs.existsSync(to) && (!fs.lstatSync(to).isDirectory() || fs.readdirSync(to).length > 0)) {
    throw new Error('Public export destination must be empty.');
  }
  const digest = digestFiles(from, files);
  fs.mkdirSync(to, { recursive: true });
  for (const filename of files) {
    const output = path.join(to, filename);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(from, filename), output);
  }
  rejectIssues(scanPublicContent(to));
  return { files, digest };
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.cwd();
    if (process.argv[2] === 'export') {
      const requested = process.argv.indexOf('--output');
      const output = requested >= 0 ? process.argv[requested + 1] : undefined;
      if (requested >= 0 && !output) throw new Error('--output requires a directory.');
      const destination = output ?? path.join('.cache', `public-source-${Date.now()}`);
      const result = exportPublicSource(root, destination);
      process.stdout.write(`Public source exported to ${destination} (${result.files.length} files, ${result.digest}).\n`);
    } else if (process.argv[2] === 'scan') {
      const target = process.argv[3];
      if (!target) throw new Error('scan requires a directory.');
      rejectIssues(scanPublicContent(target, undefined, { ...publicContentOptions(root), artifact: process.argv.includes('--package') ? 'package' : 'site' }));
      process.stdout.write('Public artifact content checked.\n');
    } else if (process.argv[2] === 'check') {
      rejectIssues(scanPublicContent(root, listPublicSourceFiles(root), publicContentOptions(root)));
      process.stdout.write('Public source content checked.\n');
    } else throw new Error('Expected check, export, or scan.');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Public content check failed.'}\n`);
    process.exitCode = 1;
  }
}
