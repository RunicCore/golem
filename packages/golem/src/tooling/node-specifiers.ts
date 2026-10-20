import fs from 'node:fs';
import path from 'node:path';
import * as ts from './typescript-ns.js';
import { hasErrorCode, isRecord } from './generator-api.js';
import type { RewriteEdit } from './rewrite.js';

export interface NodeSpecifierOptions {
  /** The program's compiler options: `paths`, `baseUrl` and `jsx` decide the new text. */
  readonly compilerOptions: ts.CompilerOptions;
  /** The absolute file names of the program's project sources (`projectSources` of rewrite-scan.ts). The checker alone cannot tell a project source from a package file. */
  readonly projectSources: ReadonlySet<string>;
}

export interface NodeSpecifierEdits {
  /** One edit for each changed specifier, in source order. Each replaces the text between the quotes. */
  readonly edits: readonly RewriteEdit[];
  /** Old text to new text of each changed specifier of the file: an import that the rewrite scan adds copies the text of a specifier here. */
  readonly specifiers: ReadonlyMap<string, string>;
}

/** The extensions of a project source. The value is the extension of its emitted file; `.tsx` and `.jsx` depend on the `jsx` option. */
const OUTPUT_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': '.js', '.mts': '.mjs', '.cts': '.cjs', '.js': '.js', '.mjs': '.mjs', '.cjs': '.cjs', '.json': '.json',
};
const JSX_EXTENSIONS = ['.tsx', '.jsx'];
const PROJECT_EXTENSIONS = [...JSX_EXTENSIONS, ...Object.keys(OUTPUT_EXTENSION)];
/** The extensions that a specifier may spell for a file whose output extension differs. */
const SPELLED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
// JsxEmit.Preserve: the seam does not export JsxEmit. TypeScript 6 and 7 number it the same.
const JSX_PRESERVE = 1;

/** A change to the end of a specifier: drop `strip` characters, then add `add`. */
interface Suffix { readonly strip: number; readonly add: string }
const UNCHANGED: Suffix = { strip: 0, add: '' };

function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function extensionOf(filename: string, extensions: readonly string[]): string | undefined {
  return extensions.find((extension) => filename.endsWith(extension));
}

/** The path of a project source without its extension. */
function stemOf(target: string): string {
  return target.slice(0, target.length - (extensionOf(target, PROJECT_EXTENSIONS)?.length ?? 0));
}

/** The extension of the file that the build emits for the project source `filename`; undefined when the file is not a kind that emits one. */
function outputExtension(filename: string, options: ts.CompilerOptions): string | undefined {
  const extension = extensionOf(filename, JSX_EXTENSIONS);
  if (extension) return options.jsx === JSX_PRESERVE ? '.jsx' : '.js';
  const found = extensionOf(filename, Object.keys(OUTPUT_EXTENSION));
  return found && OUTPUT_EXTENSION[found];
}

/**
 * How a specifier that names the path `p` must end so that Node loads `target`, a project source whose emitted file ends in
 * `extension`. Undefined when `p` does not name the target by one of the forms of spec 3.4.
 */
function suffixFor(p: string, target: string, extension: string): Suffix | undefined {
  const stem = stemOf(target);
  const spelled = extensionOf(p, SPELLED_EXTENSIONS);
  if (spelled && p.slice(0, p.length - spelled.length) === stem) return { strip: spelled.length, add: extension };
  if (p === target) return UNCHANGED;
  if (p === stem) return { strip: 0, add: extension };
  if (`${p}/index` === stem) return { strip: 0, add: `/index${extension}` };
  return undefined;
}

/** Whether `specifier` matches a key of the `paths` option: an exact key, or a key with one `*`. */
function matchesPaths(specifier: string, paths: unknown): boolean {
  if (!isRecord(paths)) return false;
  return Object.keys(paths).some((pattern) => {
    const star = pattern.indexOf('*');
    if (star < 0) return pattern === specifier;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix);
  });
}

/** The package name at the start of a bare specifier: `pkg` or `@scope/pkg`. */
function packageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!;
}

/** The `exports` field is the only thing Node reads of a package manifest here; null when the manifest is missing or is not JSON. */
function manifestOf(directory: string): Record<string, unknown> | null {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(`${directory}/package.json`, 'utf8'));
    return isRecord(manifest) ? manifest : null;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The spelled path of a project source from `file`: relative, with `./` in front, and the emitted extension. */
function relativeSpecifier(file: string, target: string, extension: string): string {
  const relative = path.posix.relative(path.posix.dirname(file), `${stemOf(target)}${extension}`);
  return relative.startsWith('../') ? relative : `./${relative}`;
}

/** The new text of a specifier whose target is a project source, or undefined when the specifier stays. */
function projectSourceSpecifier(specifier: string, file: string, target: string, options: ts.CompilerOptions): string | undefined {
  const extension = outputExtension(target, options);
  if (extension === undefined) return undefined;
  if (isRelative(specifier)) {
    // './dir/' names the folder, as './dir' does.
    const base = specifier.replace(/\/+$/, '') || specifier;
    const suffix = suffixFor(path.posix.resolve(path.posix.dirname(file), base), target, extension);
    return suffix && base.slice(0, base.length - suffix.strip) + suffix.add;
  }
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : undefined;
  const underBaseUrl = baseUrl !== undefined && suffixFor(path.posix.resolve(baseUrl, specifier), target, extension) !== undefined;
  return matchesPaths(specifier, options.paths) || underBaseUrl ? relativeSpecifier(file, target, extension) : undefined;
}

/** The new text of a deep path into a package whose manifest has no `exports`, or undefined when the specifier stays. */
function packageSpecifier(specifier: string, target: string): string | undefined {
  const name = packageName(specifier);
  const deep = specifier.slice(name.length).replace(/\/+$/, '');
  if (deep === '' || !target.endsWith('.d.ts')) return undefined;
  // Node reads `exports` from the manifest at the package root: the last node_modules/<name> segment of the path.
  const marker = `/node_modules/${name}/`;
  const at = target.lastIndexOf(marker);
  if (at < 0) return undefined;
  const root = target.slice(0, at + marker.length - 1);
  const manifest = manifestOf(root);
  if (manifest === null || (manifest.exports !== undefined && manifest.exports !== null)) return undefined;
  const stem = target.slice(0, -'.d.ts'.length);
  const runtime = `${stem}.js`;
  if (!fs.existsSync(runtime)) return undefined;
  const p = path.posix.join(root, deep);
  const base = `${name}${deep}`;
  if (p === stem) return `${base}.js`;
  if (`${p}/index` === stem) return `${base}/index.js`;
  return undefined;
}

/** The new text of one specifier, or undefined when it stays. Never throws on a specifier that it cannot resolve. */
function newSpecifier(literal: ts.StringLiteral, file: ts.SourceFile, checker: ts.TypeChecker, options: NodeSpecifierOptions): string | undefined {
  const specifier = literal.text;
  // A query or fragment, a URL scheme, an absolute path or a `#` import is no file path that golem knows.
  if (/[?#]/.test(specifier) || /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/)/.test(specifier)) return undefined;
  const declaration = checker.getSymbolAtLocation(literal)?.declarations[0];
  if (!declaration || !ts.isSourceFile(declaration)) return undefined;
  if (options.projectSources.has(declaration.fileName) && !declaration.isDeclarationFile) {
    return projectSourceSpecifier(specifier, file.fileName, declaration.fileName, options.compilerOptions);
  }
  return isRelative(specifier) ? undefined : packageSpecifier(specifier, declaration.fileName);
}

// Insertion order matters: the backslash goes first. Characters by code, not a regex literal: emit would print U+2028 raw in one.
const LITERAL_ESCAPES: readonly (readonly [string, string])[] = [
  ['\\', '\\\\'], ['\n', '\\n'], ['\r', '\\r'], ['\u2028', '\\u2028'], ['\u2029', '\\u2029'],
];

/** `text` as the inside of a string literal that `quote` opens. */
function escapedFor(quote: string, text: string): string {
  return [...LITERAL_ESCAPES, [quote, `\\${quote}`] as const].reduce((escaped, [character, escape]) => escaped.replaceAll(character, escape), text);
}

/** The module specifier of an import declaration, an `export … from`, or a dynamic `import()` with one string literal. */
function specifierLiteral(node: ts.Node, file: ts.SourceFile): ts.StringLiteral | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'import' && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0]!)) {
    return node.arguments[0];
  }
  return undefined;
}

/**
 * The edits that give each relative, `paths`/`baseUrl` and exports-less package deep-path specifier of `file` the text that Node
 * loads as ESM: the extension of the emitted file, `/index.js` for a folder. The target is the checker's own: the source file of the
 * specifier's module symbol. Every other specifier, and one the checker cannot resolve, stays.
 */
export function nodeSpecifierEdits(file: ts.SourceFile, checker: ts.TypeChecker, options: NodeSpecifierOptions): NodeSpecifierEdits {
  const edits: RewriteEdit[] = [];
  const specifiers = new Map<string, string>();
  const visit = (node: ts.Node): undefined => {
    const literal = specifierLiteral(node, file);
    if (literal) {
      const next = newSpecifier(literal, file, checker, options);
      if (next !== undefined && next !== literal.text) {
        const start = literal.getStart(file) + 1;
        const end = literal.end - 1;
        edits.push({ start, end, expect: file.text.slice(start, end), text: escapedFor(file.text.charAt(start - 1), next) });
        specifiers.set(literal.text, next);
      }
    }
    ts.forEachChild(node, visit);
    return undefined;
  };
  visit(file);
  return { edits: edits.sort((left, right) => left.start - right.start), specifiers };
}
