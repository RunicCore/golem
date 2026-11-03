import assert from 'node:assert/strict';
import * as ts from '#golem/typescript-ns';

/** The statements of `file` in `program`. */
export function statementsOf(program: ts.Program, file: string): readonly ts.Node[] {
  const source = program.getSourceFile(file);
  assert.ok(source, `${file} is not in the program`);
  return source.statements;
}

/** The names that `statement` declares and exports itself (`export const`, `export function`, `export class`); none for any other statement. */
export function declaredExportNames(statement: ts.Node): string[] {
  if (!(ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) return [];
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : []);
  return 'name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node) ? [(statement.name as ts.Identifier).text] : [];
}
