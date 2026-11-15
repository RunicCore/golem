// The source guard of `npm run lint`: which package source file may load which TypeScript module, which modules the runtime project
// loads, where a package uses a non-null assertion, and which switch over a union of kinds leaves a kind out. Tests are outside it.
// It reads the syntax tree that golem's own compiler seam parses, so a quote in a comment or a string is no import. The switch check
// asks the seam's type checker, since typescript-eslint needs the TypeScript JavaScript API that TypeScript 7 does not export.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from '../packages/golem/src/tooling/typescript-ns.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

interface Rule {
  readonly forbids: (specifier: string) => boolean;
  /** The one file that may load it, or none. */
  readonly allowedIn: string | undefined;
  readonly because: string;
}

const RULES: readonly Rule[] = [
  { forbids: specifier => /^typescript\/(?:unstable|ast|sync|async|fs|proto|path)(?:\/|$)/.test(specifier), allowedIn: 'packages/golem/src/tooling/typescript-ts7.ts', because: 'the TypeScript 7 API stays inside the generator shim' },
  { forbids: specifier => /^require\(.*\bpackageDir\b/.test(specifier), allowedIn: 'packages/golem/src/tooling/typescript-ts6.ts', because: 'only the TypeScript 6 backend loads the project\'s TypeScript by directory' },
  { forbids: specifier => specifier === 'typescript', allowedIn: undefined, because: 'the TypeScript 6 backend loads the project\'s TypeScript by the directory resolveTypeScript found; a bare import would load golem\'s own' },
];

/** The files of the runtime project (packages/golem/tsconfig.runtime.json). They ship to apps that have no mobx and no Node.js. */
const RUNTIME_FILE = /^packages\/golem\/src\/(?:client-runtime\/)?[^/]+\.ts$/;

/** Why a runtime file may not load the module, or undefined when it may: only a relative specifier outside `tooling/` is allowed. Type-only imports count. */
function runtimeLoadProblem(relative: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return `a runtime file loads only relative modules, so the apps that ship it need no mobx and no Node.js`;
  if (path.posix.join(path.posix.dirname(relative), specifier).startsWith('packages/golem/src/tooling/')) return `a runtime file does not load the build tooling, which needs Node.js`;
  return undefined;
}

/** The two source checks: a finding of either fails the run. */
const SOURCE_CHECKS = {
  nonNull: { because: 'narrow with a guard, or change the type so the value cannot be missing' },
  switchKinds: { because: 'list each kind and end with `default: return assertNever(value)`' },
} as const;

const LITERAL_TYPES = ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Undefined | ts.TypeFlags.Null;

/**
 * The names of the kinds that a switch over a union of literal types (`undefined` and `null` count) does not list, sorted, or none when
 * it is no such switch. A type parameter stands for its constraint. The result of `typeof` is no kind.
 */
function unlistedKinds(statement: ts.SwitchStatement, checker: ts.TypeChecker): string[] {
  if (ts.isTypeOfExpression(statement.expression)) return [];
  const declared = checker.getTypeAtLocation(statement.expression);
  const type = (declared.flags & ts.TypeFlags.TypeParameter) !== 0 ? checker.getBaseConstraintOfType(declared) ?? declared : declared;
  if (!type.isUnion() || !type.types.every(member => (member.flags & LITERAL_TYPES) !== 0)) return [];
  const listed = new Set<string>();
  for (const clause of statement.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    const caseType = checker.getTypeAtLocation(clause.expression);
    for (const member of caseType.isUnion() ? caseType.types : [caseType]) listed.add(checker.typeToString(member));
  }
  return type.types.map(member => checker.typeToString(member)).filter(name => !listed.has(name)).sort();
}

function portable(filename: string): string {
  return filename.split(path.sep).join('/');
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    // `sdk-runtime` is the bundle that the golem-openapi-ts build writes, not source.
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.build' || entry.name === 'sdk-runtime') continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(filename));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(filename);
  }
  return found;
}

/** What a node loads: an import or `export … from`, a dynamic `import()`, a `require()` call, an import type (`import("x").T`). A `require` of a non-literal argument is returned as `require(<argument text>)`. */
function loads(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isCallExpression(node) && node.arguments.length >= 1) {
    const [argument] = node.arguments;
    const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    if ((isImport || isRequire) && ts.isStringLiteralLike(argument!)) return argument.text;
    if (isRequire) return `require(${argument!.getText()})`;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) return node.argument.literal.text;
  return undefined;
}

function findings(file: ts.SourceFile, relative: string, checker: ts.TypeChecker): string[] {
  const found: string[] = [];
  const where = (node: ts.Node): string => `${relative}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const visit = (node: ts.Node): undefined => {
    const specifier = loads(node);
    if (specifier !== undefined) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      const runtimeProblem = RUNTIME_FILE.test(relative) ? runtimeLoadProblem(relative, specifier) : undefined;
      if (runtimeProblem !== undefined) found.push(`${relative}:${line + 1} imports '${specifier}': ${runtimeProblem}`);
      for (const rule of RULES) {
        if (rule.forbids(specifier) && relative !== rule.allowedIn) {
          found.push(`${relative}:${line + 1} imports '${specifier}'${rule.allowedIn ? `; only ${rule.allowedIn} may` : ''}: ${rule.because}`);
        }
      }
    }
    if (ts.isNonNullExpression(node)) {
      found.push(`${where(node)} non-null assertion \`${node.getText(file)}\`: ${SOURCE_CHECKS.nonNull.because}`);
    } else if (ts.isSwitchStatement(node)) {
      const unlisted = unlistedKinds(node, checker);
      if (unlisted.length > 0) found.push(`${where(node)} switch leaves out ${unlisted.join(', ')}: ${SOURCE_CHECKS.switchKinds.because}`);
    }
    ts.forEachChild(node, visit);
    return undefined;
  };
  for (const statement of file.statements) visit(statement);
  return found;
}

const files = sourceFiles(path.join(root, 'packages')).sort();
const program = ts.createProgramFromSources({ root, sources: files });
const errors: string[] = [];
try {
  const checker = program.getTypeChecker();
  for (const filename of files) {
    const file = program.getSourceFile(filename);
    if (!file) throw new Error(`The compiler did not read ${portable(path.relative(root, filename))}.`);
    errors.push(...findings(file, portable(path.relative(root, filename)), checker));
  }
} finally {
  program.close();
}
if (errors.length > 0) {
  process.stderr.write(`${errors.length} errors:\n${errors.map(line => `  ${line}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Source check passed for ${files.length} package source files.\n`);
