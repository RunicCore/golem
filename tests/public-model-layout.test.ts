import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as ts from '#golem/typescript-ns';
import { generate } from '#model/generator';
import { readFixture } from './fixture-project.js';
import { createModelProject } from './model-project.js';

/** Names a generated companion exports for application code; `__golem*` helpers are documented as internal. */
function publicExports(program: ts.Program, file: string): string[] {
  const source = program.getSourceFile(file);
  assert.ok(source, `${file} is not in the program`);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map(element => element.name.text));
      continue;
    }
    if (!(ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) continue;
    if (ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name.text] : []));
    else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) names.push((statement.name as ts.Identifier).text);
  }
  return [...new Set(names)].filter(name => !name.startsWith('__golem')).sort();
}

test('the public exports of generated model companions match the frozen list', t => {
  const expected = JSON.parse(readFixture('public-model-layout.json')) as Record<string, string[]>;
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-layout-', name: null, linkWorkspaceNodeModules: true });
  for (const name of ['codecs.ts', 'payment.model.ts']) {
    fs.writeFileSync(path.join(sourceRoot, name), readFixture(`public-model-layout/src/${name}`));
  }
  const result = generate({ root, profile: { mobx: false, validation: true, ajvStandalone: false } });
  const companions = result.artifacts.filter(a => a.path.endsWith('.model.generated.ts'));
  for (const artifact of companions) {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, artifact.content);
  }
  using program = ts.createProgramFromSources({ root, sources: companions.map(artifact => artifact.path) });
  const actual = Object.fromEntries(companions.map(artifact => [path.relative(root, artifact.path), publicExports(program, artifact.path)]));
  assert.deepEqual(actual, expected, `Public model layout changed. If intended (major release), replace tests/fixtures/public-model-layout.json with:\n${JSON.stringify(actual, null, 2)}`);
});
