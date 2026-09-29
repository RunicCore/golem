import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as ts from '#codegen/typescript-ns';
import { workspace } from './packed/helpers.js';

type Layout = Record<string, Record<string, string[]>>;

/** The names a module exports, following `export *` into the module it names. */
function exportedNames(program: ts.Program, file: string): string[] {
  const source = program.getSourceFile(file);
  assert.ok(source, `${file} is not in the program`);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) names.push(...clause.elements.map(e => e.name.text));
      else if (clause && ts.isNamespaceExport(clause)) names.push(clause.name.text);
      else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        names.push(...exportedNames(program, path.resolve(path.dirname(file), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'))));
      }
      continue;
    }
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : []));
    else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) names.push((statement.name as ts.Identifier).text);
  }
  return [...new Set(names)].sort();
}

function publicLayout(): Layout {
  const layout: Layout = {};
  for (const example of fs.readdirSync(path.join(workspace, 'examples')).sort()) {
    const sdk = path.join(workspace, 'examples', example, 'sdk');
    if (!fs.existsSync(path.join(sdk, 'index.ts'))) continue;
    const files = ['index.ts',
      ...fs.readdirSync(path.join(sdk, 'models')).filter(f => f.endsWith('.ts') && !f.startsWith('_')).map(f => `models/${f}`),
      ...(fs.existsSync(path.join(sdk, 'operations')) ? fs.readdirSync(path.join(sdk, 'operations')).filter(f => f.endsWith('.ts')).map(f => `operations/${f}`) : [])];
    using program = ts.createProgramFromSources({ root: sdk, sources: files.map(file => path.join(sdk, file)) });
    layout[example] = Object.fromEntries(files.sort().map(file => [file, exportedNames(program, path.join(sdk, file))]));
  }
  return layout;
}

test('the public SDK layout of every example matches the frozen list', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(workspace, 'tests/fixtures/public-sdk-layout.json'), 'utf8')) as Layout;
  const actual = publicLayout();
  assert.deepEqual(actual, expected, `Public SDK layout changed. If intended (major release), replace tests/fixtures/public-sdk-layout.json with:\n${JSON.stringify(actual, null, 2)}`);
});
