import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeneratedModel, ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { getValidator } from '@exprtlabs/golem/validation';
import { schemaForDescriptor } from '@exprtlabs/golem/internal/schema';
import { installCodecModel } from './register-codec-model.js';
import { compileSchema } from './support/compiled-validators.js';
import { modelCodec } from './support/model-codec.js';

function generated<Model extends object>(model: Model): Model & GeneratedModel<unknown> {
  return model as Model & GeneratedModel<unknown>;
}

test('exact frontend models ignore prototype extras while nested records stay exact', async () => {
  class Child {
    value = 2;
  }
  const child: ModelTypeDescriptor = {
    kind: 'object',
    properties: { value: { kind: 'number' } },
    required: ['value'],
    additionalProperties: false,
  };
  await installCodecModel({
    constructor: Child,
    name: 'Child',
    fields: ['value'],
    conversion: {
      encode: model => ({ value: model.value }),
      decode: value => Object.assign(new Child(), value),
    },
    definitions: { Child: child },
  });
  const settings: ModelTypeDescriptor = {
    kind: 'object',
    properties: { title: { kind: 'string' } },
    required: ['title'],
    additionalProperties: false,
  };
  class Editor {
    child = new Child();
    when = new Date('2026-01-01T00:00:00Z');
    settings: { title: string } = { title: 'Draft' };
    isSaving(): boolean { return false; }
  }
  const model: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      child: { kind: 'generated-model', id: 'Child' },
      when: { kind: 'date' },
      settings,
    },
    required: ['child', 'when', 'settings'],
    additionalProperties: false,
  };
  await installCodecModel({
    constructor: Editor,
    name: 'Editor',
    fields: ['child', 'when', 'settings'],
    nestedCodecIds: ['Child'],
    conversion: {
      encode: value => ({
        child: { value: value.child.value },
        when: value.when.toISOString(),
        settings: value.settings,
      }),
      decode: value => {
        throw new Error(`decode must not run for invalid wire input: ${JSON.stringify(value)}`);
      },
    },
    definitions: { Editor: model },
  });
  const editor = new Editor();
  const validator = getValidator<Editor>(editor);
  assert.equal(await validator.validate(), true);
  const json = modelCodec(generated(editor)).toWireFormat(generated(editor));
  assert.deepEqual(json, { child: { value: 2 }, when: '2026-01-01T00:00:00.000Z', settings: { title: 'Draft' } });
  const wire = {
    ...model,
    properties: { ...model.properties, child, when: { kind: 'string' as const } },
  };
  const editorWire = await compileSchema(schemaForDescriptor(wire));
  const unexpected = { ...json as Record<string, unknown>, unexpected: true };
  assert.equal(editorWire(unexpected, false).length > 0, true);
  assert.deepEqual(editorWire(json, false), []);
});
