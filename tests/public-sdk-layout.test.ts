import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import * as ts from '#golem/typescript-ns';
import { writeSdk } from '#openapi/generator';
import { createFixtureProject, readFixture, writeGeneratedArtifacts } from './fixture-project.js';

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

/** The generated SDK profiles whose public layout is frozen. */
const PROFILES = {
  'mobx-off': { mobx: false, validation: true },
  'mobx-on': { mobx: true, validation: true },
} as const;

function publicLayout(sdk: string): Record<string, string[]> {
  const files = ['index.ts',
    ...fs.readdirSync(path.join(sdk, 'models')).filter(f => f.endsWith('.ts') && !f.startsWith('_')).map(f => `models/${f}`),
    ...(fs.existsSync(path.join(sdk, 'operations')) ? fs.readdirSync(path.join(sdk, 'operations')).filter(f => f.endsWith('.ts') && !f.endsWith('.validators.generated.ts')).map(f => `operations/${f}`) : [])];
  using program = ts.createProgramFromSources({ root: sdk, sources: files.map(file => path.join(sdk, file)) });
  return Object.fromEntries(files.sort().map(file => [file, exportedNames(program, path.join(sdk, file))]));
}

test('the public SDK layout generated from a fixture document matches the frozen list', t => {
  const expected = JSON.parse(readFixture('public-sdk-layout.json')) as Layout;
  const document = parse(readFixture('public-sdk-layout/openapi.yaml')) as Record<string, any>;
  // A response link and a webhook freeze the names that links.ts and inbound.ts add to sdk/index.js.
  document.paths['/api/payments/transactions'].post.responses['201'].links = {
    getCreated: { operationId: 'getPayment', parameters: { id: '$response.body#/id' } },
  };
  document.webhooks = {
    paymentSettled: {
      post: {
        operationId: 'paymentSettled',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } },
        responses: { 204: { description: 'Received' } },
      },
    },
  };
  const actual: Layout = {};
  for (const [name, profile] of Object.entries(PROFILES)) {
    const sdk = path.join(createFixtureProject(t, `golem-sdk-layout-${name}-`), 'sdk');
    writeGeneratedArtifacts(writeSdk(document, { output: sdk, name: 'Payments', profile }).artifacts);
    actual[name] = publicLayout(sdk);
    // A model group's validators module is internal: its name starts with `_`, so the public layout never lists it.
    const validators = fs.readdirSync(path.join(sdk, 'models')).filter(f => f.endsWith('.validators.generated.ts'));
    assert.ok(validators.length > 0 && validators.every(f => f.startsWith('_')), name);
    // An operation's validators module sits next to it and is internal as well: the layout lists only the operation files.
    assert.ok(fs.readdirSync(path.join(sdk, 'operations')).some(f => f.endsWith('.validators.generated.ts')), name);
  }
  assert.deepEqual(actual, expected, `Public SDK layout changed. If intended (major release), replace tests/fixtures/public-sdk-layout.json with:\n${JSON.stringify(actual, null, 2)}`);
});
