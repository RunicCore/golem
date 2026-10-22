import fs from 'node:fs';
import path from 'node:path';
import * as ts from './typescript-ns.js';
import { isRecord } from './generator-api.js';
import { matchStarPattern } from './star-pattern.js';
import { readManifest } from './type-analysis/package-specifier.js';
import type { RewriteEdit } from './rewrite.js';

/** Pass one object for all the files of a build: it also keys what the build reads from the disk (package roots and files), so each is read once. */
interface NodeSpecifierOptions {
  /** The program's compiler options: `paths` and `jsx` decide the new text. */
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

/** Whether `specifier` matches a key of the `paths` option. */
function matchesPaths(specifier: string, paths: unknown): boolean {
  return isRecord(paths) && Object.keys(paths).some((pattern) => matchStarPattern(pattern, specifier) !== undefined);
}

/** The package name at the start of a bare specifier: `pkg` or `@scope/pkg`. */
function packageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!;
}

/** What one build learned from the disk, kept for the options object it passes to every file: a package root, a file. */
const diskAnswers = new WeakMap<NodeSpecifierOptions, Map<string, unknown>>();

function remembered<T>(options: NodeSpecifierOptions, key: string, read: () => T): T {
  let answers = diskAnswers.get(options);
  if (!answers) diskAnswers.set(options, answers = new Map());
  if (!answers.has(key)) answers.set(key, read());
  return answers.get(key) as T;
}

/** The package folder that Node finds for `name`: the nearest `node_modules/<name>` from the folder of the importing file upward. */
function packageRoot(directory: string, name: string, options: NodeSpecifierOptions): string | undefined {
  for (let current = directory; ; current = path.posix.dirname(current)) {
    const candidate = path.posix.join(current, 'node_modules', name);
    if (remembered(options, `directory:${candidate}`, () => fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true)) return candidate;
    if (path.posix.dirname(current) === current) return undefined;
  }
}

function isFile(filename: string, options: NodeSpecifierOptions): boolean {
  return remembered(options, `file:${filename}`, () => fs.statSync(filename, { throwIfNoEntry: false })?.isFile() === true);
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
  return matchesPaths(specifier, options.paths) ? relativeSpecifier(file, target, extension) : undefined;
}

/**
 * The new text of a deep path into a package whose manifest has no `exports`, or undefined when the specifier stays. The
 * runtime files are the package's own, where Node looks for them; the types may come from elsewhere, such as `@types/<name>`.
 */
function packageSpecifier(specifier: string, file: string, options: NodeSpecifierOptions): string | undefined {
  const name = packageName(specifier);
  const deep = specifier.slice(name.length).replace(/\/+$/, '');
  if (deep === '') return undefined;
  const root = packageRoot(path.posix.dirname(file), name, options);
  if (root === undefined) return undefined;
  // readManifest throws for a package.json that is not JSON: the build stops and names the file.
  const manifest = readManifest(`${root}/package.json`);
  if (manifest === undefined || (manifest.exports !== undefined && manifest.exports !== null)) return undefined;
  const runtime = path.posix.join(root, deep);
  if (isFile(runtime, options)) return undefined;
  if (isFile(`${runtime}.js`, options)) return `${name}${deep}.js`;
  if (isFile(`${runtime}/index.js`, options)) return `${name}${deep}/index.js`;
  return undefined;
}

const EXTENSIONLESS = ['.ts', '.tsx', '.js', '.jsx'];

/** The paths that a `paths` alias maps `specifier` to: the targets of its exact key, else of the key with the longest prefix, against the base of the `paths`. */
function aliasPaths(specifier: string, compilerOptions: ts.CompilerOptions): string[] {
  const { paths } = compilerOptions;
  const base = compilerOptions.baseUrl ?? compilerOptions.pathsBasePath;
  if (!isRecord(paths) || typeof base !== 'string') return [];
  let best: { readonly star: string; readonly prefix: number; readonly targets: unknown } | undefined;
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = matchStarPattern(pattern, specifier);
    const prefix = pattern.indexOf('*') < 0 ? Infinity : pattern.indexOf('*');
    if (star !== undefined && (!best || prefix > best.prefix)) best = { star, prefix, targets };
  }
  if (!best || !Array.isArray(best.targets)) return [];
  const { star, targets } = best;
  return targets.map((target) => path.posix.resolve(base, String(target).replace('*', star)));
}

/**
 * The project source that a specifier names when the checker gives it no module symbol: a script file (no import or export, so a
 * side-effect import of it has no symbol). A relative specifier names a path; a `paths` alias names the paths of its targets.
 * The names that TypeScript tries, in its order.
 */
function scriptTarget(specifier: string, file: string, options: NodeSpecifierOptions): string | undefined {
  const candidates = isRelative(specifier)
    ? [path.posix.resolve(path.posix.dirname(file), specifier.replace(/\/+$/, '') || specifier)]
    : aliasPaths(specifier, options.compilerOptions);
  for (const p of candidates) {
    const names = [p, ...EXTENSIONLESS.map((extension) => `${p}${extension}`), ...EXTENSIONLESS.map((extension) => `${p}/index${extension}`)];
    const found = names.find((name) => options.projectSources.has(name) && !name.endsWith('.d.ts'));
    if (found) return found;
  }
  return undefined;
}

/**
 * The new text of one specifier, or undefined when it stays. A specifier that the checker cannot resolve stays, with one exception:
 * a specifier with no module symbol (a side-effect import of a script file) takes the new text of the project source it names,
 * also through a `paths` alias.
 * It throws only when a package.json that a deep path needs is not a JSON object: `readManifest` names the file.
 */
function newSpecifier(literal: ts.StringLiteral, file: ts.SourceFile, checker: ts.TypeChecker, options: NodeSpecifierOptions): string | undefined {
  const specifier = literal.text;
  // A query or fragment, a URL scheme, an absolute path or a `#` import is no file path that golem knows.
  if (/[?#]/.test(specifier) || /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/)/.test(specifier)) return undefined;
  const symbol = checker.getSymbolAtLocation(literal);
  if (!symbol) {
    const script = scriptTarget(specifier, file.fileName, options);
    return script && projectSourceSpecifier(specifier, file.fileName, script, options.compilerOptions);
  }
  const declaration = symbol.declarations[0];
  if (!declaration || !ts.isSourceFile(declaration)) return undefined;
  if (options.projectSources.has(declaration.fileName) && !declaration.isDeclarationFile) {
    return projectSourceSpecifier(specifier, file.fileName, declaration.fileName, options.compilerOptions);
  }
  return isRelative(specifier) ? undefined : packageSpecifier(specifier, file.fileName, options);
}

// `import` then `(`, with whitespace and comments between: `import /* c */ ('./x')`.
const DYNAMIC_IMPORT = /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(/;

// Characters by code, not a regex literal: emit would print U+2028 raw in one.
const UNSAFE_IN_LITERAL = ['\\', '\n', '\r', '\u2028', '\u2029'];

/** The module specifier of an import declaration, an `export … from`, a dynamic `import()` with one string literal, or an import type (`import("x").T`, which declaration files hold). */
function specifierLiteral(node: ts.Node): ts.StringLiteral | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0]!)) {
    return node.arguments[0];
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) return node.argument.literal;
  return undefined;
}

/**
 * The edits that give each relative, `paths` alias and exports-less package deep-path specifier of `file` the text that Node
 * loads as ESM: the extension of the emitted file, `/index.js` for a folder. The target is the checker's own: the source file of the
 * specifier's module symbol, or, for a relative specifier with no symbol, the project source it names. Every other specifier stays.
 */
export function nodeSpecifierEdits(file: ts.SourceFile, checker: ts.TypeChecker, options: NodeSpecifierOptions): NodeSpecifierEdits {
  const edits: RewriteEdit[] = [];
  const specifiers = new Map<string, string>();
  // An import declaration and an `export … from` are top-level statements; only an `import(` call or an import type can sit deeper.
  const dynamic = DYNAMIC_IMPORT.test(file.text);
  const rewrite = (node: ts.Node): undefined => {
    const literal = specifierLiteral(node);
    if (literal) {
      const next = newSpecifier(literal, file, checker, options);
      const start = literal.getStart(file) + 1;
      const quote = file.text.charAt(start - 1);
      // A new text that needs an escape in this literal is a file name that golem does not rewrite: the specifier stays.
      if (next !== undefined && next !== literal.text && ![...UNSAFE_IN_LITERAL, quote].some((character) => next.includes(character))) {
        const end = literal.end - 1;
        edits.push({ start, end, expect: file.text.slice(start, end), text: next });
        specifiers.set(literal.text, next);
      }
    }
    if (dynamic) ts.forEachChild(node, rewrite);
    return undefined;
  };
  for (const statement of file.statements) rewrite(statement);
  return { edits: edits.sort((left, right) => left.start - right.start), specifiers };
}
