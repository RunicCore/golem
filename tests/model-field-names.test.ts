import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createModelProject, writeModelSources } from './model-project.js';
import { tsSource } from './source-template.js';
import { generate } from '#model/generator';

const modelProject = (t: Parameters<typeof createModelProject>[0]) => createModelProject(t, {
  prefix: 'golem-model-field-names-',
  name: 'model-field-names',
});

function prototypeDiagnostic(field: string): string {
  return `Declared model field ${JSON.stringify(field)} conflicts with a built-in Object.prototype member; rename the field`;
}

test('model generation rejects Object.prototype-colliding data fields across validation profiles', t => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-model-field-names-',
    name: 'model-field-names',
    compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true },
  });
  const source = path.join(sourceRoot, 'field-names.model.ts');
  const cases = [
    {
      field: '__proto__',
      declaration: 'export type TBad = IModel<{ __proto__: string }>;',
    },
    {
      field: 'constructor',
      declaration: 'export type TBad = IModel<{ constructor: string }>;',
    },
    {
      field: 'toString',
      declaration: 'export type TBad = IModel<{ toString?: string }>;',
    },
    {
      field: 'constructor',
      declaration: [
        'interface BaseFields { constructor: string }',
        'interface InheritedFields extends BaseFields { label?: string }',
        'export type TBad = IModel<InheritedFields>;',
      ].join('\n'),
    },
  ] as const;
  for (const scenario of cases) {
    fs.writeFileSync(source, [
      "import type { IModel } from '@exprtlabs/golem/model';",
      scenario.declaration,
      '',
    ].join('\n'));
    assert.throws(
      () => generate({ root, sources: [source], profile: { mobx: false, validation: false } }),
      (error: unknown) => error instanceof Error
        && error.message.includes(prototypeDiagnostic(scenario.field)),
      `${scenario.field} must be rejected during analysis even with validation disabled`,
    );
  }
  fs.writeFileSync(source, [
    "import type { IModel } from '@exprtlabs/golem/model';",
    'export type TBad = IModel<{ valueOf?: string }>;',
    '',
  ].join('\n'));
  assert.throws(
    () => generate({ root, sources: [source], profile: { mobx: false, validation: true } }),
    (error: unknown) => error instanceof Error
      && error.message.includes(prototypeDiagnostic('valueOf')),
    'valueOf must be rejected during analysis when validation is enabled',
  );

  fs.writeFileSync(source, [
    "import type { IModel } from '@exprtlabs/golem/model';",
    'export type TMethods = IModel<{ toString(): string; hasOwnProperty(name: PropertyKey): boolean }>;',
    '',
  ].join('\n'));
  assert.doesNotThrow(() => generate({ root, sources: [source], profile: { mobx: false, validation: false } }));
});

test('generated model API members are rejected before emitting companions', (t) => {
  const { root, sourceRoot } = modelProject(t);
  const source = path.join(sourceRoot, 'dollar-validator.model.ts');
  writeModelSources(sourceRoot, {
    'dollar-validator.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TValidator = IModel<{ '$validator': string }>;
`,
  });
  assert.throws(
    () => generate({ root, sources: [source], profile: { mobx: false, validation: false } }),
    /collides with a generated API member/,
    'Expected reserved field $validator to be rejected',
  );
});
