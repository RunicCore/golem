import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { compilePlanValidators, type CodecValidationPlan, type PlanValidators } from '@exprtlabs/golem/internal/validation-plan';
import { analyzeOpenApiModels, generateOpenApiModelArtifacts } from '#openapi/models';

import { workspace } from '../support/process.js';
import { stripTypes } from '../support/run-module.js';

/** Models that several groups share: a union of variants over a base, and an owner and a toy that reach into it. */
function sharedModelsDocument(): Record<string, unknown> {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const variant = (properties: Record<string, unknown>, required: string[]) => ({
    allOf: [ref('Base'), { type: 'object', required, properties }],
  });
  return {
    openapi: '3.1.0',
    info: { title: 'Plans', version: '1' },
    paths: {},
    components: {
      schemas: {
        Base: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
        Cat: variant({ name: { type: 'string', minLength: 1 }, toy: ref('Toy') }, ['name']),
        Dog: variant({ bark: { type: 'boolean' } }, ['bark']),
        Pet: {
          oneOf: [ref('Cat'), ref('Dog')],
          discriminator: { propertyName: 'kind', mapping: { feline: '#/components/schemas/Cat', canine: '#/components/schemas/Dog' } },
        },
        Owner: {
          type: 'object',
          required: ['pet'],
          additionalProperties: false,
          properties: { pet: ref('Pet'), pets: { type: 'array', items: ref('Pet') }, id: { type: 'string', readOnly: true } },
        },
        Toy: { type: 'object', required: ['shape'], properties: { shape: { type: 'string', enum: ['ball', 'rope'] } } },
      },
    },
  };
}

const PROBES: readonly unknown[] = [
  null, 1, 'text', [], {},
  { kind: 'feline', name: 'Tom' },
  { kind: 'feline', name: '' },
  { kind: 'feline', name: 'Tom', toy: { shape: 'ball' } },
  { kind: 'feline', name: 'Tom', toy: { shape: 'cube' } },
  { kind: 'canine', bark: true },
  { kind: 'canine', bark: 'loud' },
  { kind: 'fish' },
  { kind: 'feline' },
  { shape: 'rope' },
  { shape: 'cube' },
  { pet: { kind: 'feline', name: 'Tom' } },
  { pet: { kind: 'canine', bark: 'loud' }, pets: [{ kind: 'canine', bark: true }] },
  { pet: { kind: 'canine', bark: true }, pets: [{ kind: 'fish' }] },
  { pet: { kind: 'canine', bark: true }, id: 'server', extra: 1 },
];

/** Loads the validators a plan compiles to, by export name; the module is TypeScript and imports the runtime by package name. */
async function loadValidators(compiled: PlanValidators, directory: string, name: string): Promise<Readonly<Record<string, Validator>>> {
  const runtime = pathToFileURL(path.join(workspace, 'packages/golem/dist/runtime-validation.js')).href;
  const source = compiled.source.replaceAll('"@exprtlabs/golem/internal/validation-runtime"', JSON.stringify(runtime));
  const file = path.join(directory, `${name}.mjs`);
  writeFileSync(file, stripTypes(source));
  return await import(pathToFileURL(file).href) as Readonly<Record<string, Validator>>;
}

test('the whole-graph plan validates every model as the plan of its own group does', async t => {
  const document = sharedModelsDocument();
  const directory = mkdtempSync(path.join(tmpdir(), 'golem-validator-plans-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let whole: CodecValidationPlan | undefined;
  let groups: ReadonlyMap<string, CodecValidationPlan> | undefined;
  generateOpenApiModelArtifacts(document, { mobx: false, validation: true, allowAny: false }, analyzeOpenApiModels(document, true), {
    compileValidators: ({ plan, groupPlans }) => {
      whole = plan;
      groups = groupPlans;
      return compilePlanValidators(plan, { owner: 'test', unknownFormats: 'warn', documentName: 'the document' });
    },
  });
  assert.ok(whole && groups);
  const dependent = [...groups.values()].filter(plan => Object.keys(plan.schemas).some(id => !plan.ownSchemas.includes(id)));
  assert.ok(groups.size > 1 && dependent.length > 0, 'the models fall into groups that reach into one another');

  const wholeCompiled = compilePlanValidators(whole, { owner: 'test', unknownFormats: 'warn', documentName: 'the document' });
  const wholeValidators = await loadValidators(wholeCompiled, directory, 'whole');
  let accepted = 0;
  let rejected = 0;
  let index = 0;
  for (const [groupId, plan] of groups) {
    const compiled = compilePlanValidators(plan, { owner: 'test', unknownFormats: 'warn', documentName: 'the document' });
    const groupValidators = await loadValidators(compiled, directory, `group${index++}`);
    assert.ok(plan.ownSchemas.length > 0, groupId);
    for (const id of plan.ownSchemas) {
      const fromGroup = groupValidators[compiled.exports.get(id) ?? ''];
      const fromWhole = wholeValidators[wholeCompiled.exports.get(id) ?? ''];
      assert.equal(typeof fromGroup, 'function', `${groupId} ${id}`);
      assert.equal(typeof fromWhole, 'function', `whole plan ${id}`);
      for (const probe of PROBES) {
        for (const all of [true, false]) {
          const expected = fromGroup(probe, all);
          assert.deepEqual(fromWhole(probe, all), expected, `${id} on ${JSON.stringify(probe)} (all: ${all})`);
          if (all) {
            if (expected.length === 0) accepted++;
            else rejected++;
          }
        }
      }
    }
  }
  assert.ok(accepted > 0 && rejected > 0, 'the probes include values that pass and values that fail');
});
