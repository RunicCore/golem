// The dependency guard of `npm run lint`: which package source file may load which TypeScript module.
// It reads the specifiers from the syntax tree that golem's own compiler seam parses, so a quote in a comment or a string is no import.
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
  { forbids: specifier => specifier === 'typescript/unstable' || specifier.startsWith('typescript/unstable/'), allowedIn: 'packages/golem/src/tooling/typescript-ts7.ts', because: 'the TypeScript 7 API stays inside the generator shim' },
  { forbids: specifier => /^require\(.*\bpackageDir\b/.test(specifier), allowedIn: 'packages/golem/src/tooling/typescript-ts6.ts', because: 'only the TypeScript 6 backend loads the project\'s TypeScript by directory' },
  { forbids: specifier => specifier === 'typescript', allowedIn: undefined, because: 'the TypeScript 6 backend loads the project\'s TypeScript by the directory resolveTypeScript found; a bare import would load golem\'s own' },
];

function portable(filename: string): string {
  return filename.split(path.sep).join('/');
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.build') continue;
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

function problems(file: ts.SourceFile, relative: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): undefined => {
    const specifier = loads(node);
    if (specifier !== undefined) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      for (const rule of RULES) {
        if (rule.forbids(specifier) && relative !== rule.allowedIn) {
          found.push(`${relative}:${line + 1} imports '${specifier}'${rule.allowedIn ? `; only ${rule.allowedIn} may` : ''}: ${rule.because}`);
        }
      }
    }
    ts.forEachChild(node, visit);
    return undefined;
  };
  for (const statement of file.statements) visit(statement);
  return found;
}

const files = sourceFiles(path.join(root, 'packages')).sort();
const program = ts.createProgramFromSources({ root, sources: files });
const failures: string[] = [];
try {
  for (const filename of files) {
    const file = program.getSourceFile(filename);
    if (!file) throw new Error(`The compiler did not read ${portable(path.relative(root, filename))}.`);
    failures.push(...problems(file, portable(path.relative(root, filename))));
  }
} finally {
  program.close();
}
if (failures.length > 0) {
  process.stderr.write(`Forbidden imports:\n${failures.map(line => `  ${line}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Import check passed for ${files.length} package source files.\n`);
