import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import * as ts from '#golem/typescript-ns';
import { writeSdk } from '#openapi/generator';
import { createFixtureProject, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { declaredExportNames, statementsOf } from './support/public-exports.js';

type Layout = Record<string, Record<string, string[]>>;

/** The names a module exports, following `export *` into the module it names. */
function exportedNames(program: ts.Program, file: string): string[] {
  const names: string[] = [];
  for (const statement of statementsOf(program, file)) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) names.push(...clause.elements.map(e => e.name.text));
      else if (clause && ts.isNamespaceExport(clause)) names.push(clause.name.text);
      else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        names.push(...exportedNames(program, path.resolve(path.dirname(file), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'))));
      }
      continue;
    }
    names.push(...declaredExportNames(statement));
  }
  return [...new Set(names)].sort();
}

/** The generated SDK profiles whose public layout is frozen: MobX needs the golem mode, which imports the codecs file the models job writes. */
const PROFILES = {
  'mobx-off': { profile: { mobx: false, validation: true }, mode: 'standalone', ownValidators: true },
  'mobx-on': { profile: { mobx: true, validation: true }, mode: 'golem', ownValidators: false },
} as const;

function publicLayout(sdk: string): Record<string, string[]> {
  const files = ['index.ts',
    ...(fs.existsSync(path.join(sdk, 'operations')) ? fs.readdirSync(path.join(sdk, 'operations')).filter(f => f.endsWith('.ts')).map(f => `operations/${f}`) : [])];
  using program = ts.createProgramFromSources({ root: sdk, sources: files.map(file => path.join(sdk, file)) });
  return Object.fromEntries(files.sort().map(file => [file, exportedNames(program, path.join(sdk, file))]));
}

test('the public SDK layout generated from a fixture document matches the frozen list', t => {
  const expected = JSON.parse(readFixture('public-sdk-layout.json')) as Layout;
  const document = parse(readFixture('public-sdk-layout/openapi.yaml')) as Record<string, any>;
  // A response link and a webhook freeze the names that links.ts and the webhook's types add to sdk/index.js.
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
  for (const [name, { profile, mode, ownValidators }] of Object.entries(PROFILES)) {
    const sdk = path.join(createFixtureProject(t, `golem-sdk-layout-${name}-`), 'sdk');
    writeGeneratedArtifacts(writeSdk(document, { output: sdk, name: 'Payments', profile, mode, codecsFile: path.resolve(sdk, 'codecs.generated.ts') }).artifacts);
    actual[name] = publicLayout(sdk);
    // A standalone SDK carries its validators module at its root (internal: the layout lists index.ts and the operations); a golem-mode SDK compiles them in the models job.
    assert.equal(fs.existsSync(path.join(sdk, 'validators.generated.ts')), ownValidators, name);
  }
  assert.deepEqual(actual, expected, `Public SDK layout changed. If intended (major release), replace tests/fixtures/public-sdk-layout.json with:\n${JSON.stringify(actual, null, 2)}`);
});
