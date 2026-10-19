import { copyFixtureFile, createFixtureProject, fileFixtureScope, onceShared } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { GeneratedModel } from '@exprtlabs/golem/model';
import { getValidator } from '@exprtlabs/golem/validation';
import { generatedCodecIdFromRoot } from '../support/consumer.js';
import { compileGeneratedSdk, generateMaterializedSdk, requireRecord } from './helpers.js';

/**
 * One row is one allOf shape. For each row the generated SDK is checked on every path that reads the shape: the generated type
 * (a compile-time fixture), the model path (decodeGeneratedModel and encodeGeneratedModel), the codec (fromWireFormat and
 * toWireFormat) and the validator, with validation on and off.
 *
 * `additionalProperties` inside an allOf member follows strict JSON Schema: a member judges every name that it does not list in
 * its own `properties`, the names of its siblings included.
 */

type Wire = Record<string, unknown>;
type Fields = Record<string, unknown>;
type ModelConstructor = new (values?: Record<string, unknown>) => Record<string, unknown>;

interface Accepted {
  /** The JSON the codec reads and writes. */
  readonly wire: Wire;
  /** The decoded model's own fields. */
  readonly model: Fields;
}

interface Row {
  readonly shape: string;
  /** The file in tests/fixtures/openapi/composition that states the generated type; a row without one checks no type. */
  readonly fixture?: string;
  /** The generated model that the claims read. */
  readonly root: string;
  readonly document: Record<string, unknown>;
  readonly accepted: readonly Accepted[];
  /** Inputs that the validator rejects, checked with validation on. */
  readonly rejected: readonly Wire[];
  /**
   * Inputs that the codec rejects, whose rejected names a generated class does not hold: its constructor keeps only its
   * declared fields, so the model path has no such name to check.
   */
  readonly rejectedOnWire?: readonly Wire[];
}

const AT = '2024-05-06T07:08:09.000Z';
const B = '2024-05-07T08:09:10.000Z';
const dateTime = { type: 'string', format: 'date-time' };
const text = { type: 'string' };

/** A `Visit` object whose one field `m` (or the named property) holds the schema under test. */
function visitDocument(properties: Record<string, unknown>, components: Record<string, unknown> = {}): Record<string, unknown> {
  return componentDocument('Visit', {
    Visit: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
    ...components,
  });
}

function componentDocument(root: string, schemas: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Composition', version: '1' },
    paths: {
      '/root': {
        get: {
          operationId: 'getRoot',
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/${root}` } } } },
          },
        },
      },
    },
    components: { schemas },
  };
}

const ref = (name: string): Record<string, unknown> => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...more,
});

const rows: readonly Row[] = [
  {
    shape: 'disjoint inline objects (T-80, T-91)',
    fixture: 'disjoint-objects',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ at: dateTime }), object({ b: dateTime })] } }),
    accepted: [
      { wire: { m: { at: AT, b: B } }, model: { m: { at: new Date(AT), b: new Date(B) } } },
      { wire: { m: { b: B } }, model: { m: { b: new Date(B) } } },
      { wire: { m: {} }, model: { m: {} } },
    ],
    rejected: [],
  },
  {
    shape: 'own properties plus an allOf member that adds properties (T-80)',
    fixture: 'own-plus-member',
    root: 'Visit',
    document: visitDocument({ m: { type: 'object', properties: { at: dateTime }, allOf: [{ properties: { b: dateTime } }] } }),
    accepted: [
      { wire: { m: { at: AT, b: B } }, model: { m: { at: new Date(AT), b: new Date(B) } } },
      { wire: { m: { b: B } }, model: { m: { b: new Date(B) } } },
      { wire: { m: {} }, model: { m: {} } },
    ],
    rejected: [],
  },
  {
    shape: 'an allOf member requires an own property',
    fixture: 'required-member',
    root: 'Visit',
    document: visitDocument({ m: { type: 'object', properties: { at: dateTime }, allOf: [{ required: ['at'] }] } }),
    accepted: [{ wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } }],
    rejected: [{ m: {} }],
  },
  {
    shape: 'array of allOf object members (T-94)',
    fixture: 'array-items',
    root: 'Visit',
    document: visitDocument({
      e: { type: 'array', items: { allOf: [object({ a: dateTime }), object({ b: dateTime })] } },
    }),
    accepted: [
      { wire: { e: [{ a: AT, b: B }, { a: AT }] }, model: { e: [{ a: new Date(AT), b: new Date(B) }, { a: new Date(AT) }] } },
      { wire: { e: [] }, model: { e: [] } },
    ],
    rejected: [],
  },
  {
    shape: 'a constraint-only allOf member (minProperties) beside own properties',
    fixture: 'constraint-only',
    root: 'Visit',
    document: visitDocument({ m: { type: 'object', properties: { at: dateTime }, allOf: [{ minProperties: 1 }] } }),
    accepted: [{ wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } }],
    rejected: [{ m: {} }],
  },
  {
    shape: 'a nullable object with a constraint-only allOf member',
    fixture: 'nullable-constraint-only',
    root: 'Visit',
    document: visitDocument({ m: { type: ['object', 'null'], properties: { at: dateTime }, allOf: [{ minProperties: 1 }] } }),
    accepted: [
      { wire: { m: null }, model: { m: null } },
      { wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } },
    ],
    rejected: [{ m: {} }],
  },
  {
    shape: 'inheritance: a component allOf [$ref Base, own properties]',
    fixture: 'inheritance',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ baseAt: dateTime, label: text }, { required: ['baseAt'] }),
      Derived: { allOf: [ref('Base'), object({ derivedAt: dateTime }, { required: ['derivedAt'] })] },
    }),
    accepted: [
      { wire: { baseAt: AT, label: 'l', derivedAt: B }, model: { baseAt: new Date(AT), label: 'l', derivedAt: new Date(B) } },
      { wire: { baseAt: AT, derivedAt: B }, model: { baseAt: new Date(AT), derivedAt: new Date(B) } },
    ],
    rejected: [{ derivedAt: B }],
  },
  {
    shape: 'polymorphism: Pet is oneOf [Cat, Dog] and each variant is allOf [$ref PetBase, own properties]',
    fixture: 'polymorphism',
    root: 'Pet',
    document: componentDocument('Pet', {
      PetBase: object({ kind: text }, { required: ['kind'] }),
      Cat: { allOf: [ref('PetBase'), object({ kind: { const: 'cat' }, name: text, born: dateTime }, { required: ['kind', 'name'] })] },
      Dog: { allOf: [ref('PetBase'), object({ kind: { const: 'dog' }, name: text }, { required: ['kind', 'name'] })] },
      Pet: {
        oneOf: [ref('Cat'), ref('Dog')],
        discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } },
      },
    }),
    accepted: [
      { wire: { kind: 'cat', name: 'n', born: AT }, model: { kind: 'cat', name: 'n', born: new Date(AT) } },
      { wire: { kind: 'dog', name: 'n' }, model: { kind: 'dog', name: 'n' } },
    ],
    rejected: [{ kind: 'cat' }],
  },
  {
    shape: 'a narrowed property with an equal conversion (const over string)',
    fixture: 'narrowed-equal',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ kind: text, at: dateTime }, { required: ['kind'] }),
      Derived: { allOf: [ref('Base'), object({ kind: { const: 'cat' }, name: text }, { required: ['kind'] })] },
    }),
    accepted: [{ wire: { kind: 'cat', at: AT, name: 'n' }, model: { kind: 'cat', at: new Date(AT), name: 'n' } }],
    rejected: [{ kind: 'dog', name: 'n' }],
  },
  // Strict JSON Schema for additionalProperties inside allOf: the validator already rejects these inputs and must keep doing so.
  {
    shape: 'strict b1: an additionalProperties string member rejects a number sibling',
    fixture: 'strict-b1',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [{ type: 'object', additionalProperties: text }, object({ n: { type: 'number' } })] } }),
    accepted: [
      { wire: { m: {} }, model: { m: {} } },
      { wire: { m: { x: 'q' } }, model: { m: { x: 'q' } } },
    ],
    rejected: [{ m: { n: 1 } }],
    // The type of a name that the validator always rejects is `n?: never`.
  },
  {
    shape: 'strict b1: the same members accept a string sibling',
    fixture: 'strict-b1-string',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [{ type: 'object', additionalProperties: text }, object({ n: text })] } }),
    accepted: [{ wire: { m: { n: 'a' } }, model: { m: { n: 'a' } } }],
    rejected: [{ m: { n: 1 } }],
  },
  {
    shape: 'strict b2: an additionalProperties false member rejects a sibling property',
    fixture: 'strict-b2',
    root: 'Visit',
    document: visitDocument({
      m: { allOf: [{ type: 'object', additionalProperties: false, properties: { a: text } }, object({ b: text })] },
    }),
    accepted: [{ wire: { m: { a: 'x' } }, model: { m: { a: 'x' } } }],
    rejected: [{ m: { a: 'x', b: 'y' } }, { m: { b: 'y' } }],
    // The type shows `b?: never`.
  },
  // A closed base with a derived optional own property: the validator rejects `b`, and the type shows `b?: never`.
  {
    shape: 'closed base and a component with an optional own property',
    fixture: 'closed-base-optional',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: { type: 'object', additionalProperties: false, properties: { a: text } },
      Derived: { allOf: [ref('Base'), object({ b: dateTime })] },
    }),
    accepted: [{ wire: { a: 'x' }, model: { a: 'x' } }],
    rejected: [{ a: 'x', b: B }, { b: B }],
  },
  // The user's answer: strict JSON Schema, and `unevaluatedProperties: false` closes an object to every name that any member
  // declares. An open base and a derived component that sets it accept the base and own names and reject any other name.
  {
    shape: 'an open base and a component with unevaluatedProperties false',
    fixture: 'unevaluated-open-base',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ a: text }),
      Derived: { allOf: [ref('Base'), object({ b: dateTime })], unevaluatedProperties: false },
    }),
    accepted: [{ wire: { a: 'x', b: B }, model: { a: 'x', b: new Date(B) } }],
    rejected: [],
    rejectedOnWire: [{ a: 'x', b: B, z: 'q' }],
  },
  // The T-99 shapes reject invalid input as strict JSON Schema does.
  {
    shape: 'T-99b strict: an additionalProperties string member rejects a number name',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [{ type: 'object', additionalProperties: text }, object({ at: dateTime })] } }),
    accepted: [],
    rejected: [{ m: { other: 1 } }],
  },
  {
    shape: 'T-99c strict: a member with properties and additionalProperties rejects a number name',
    root: 'Visit',
    document: visitDocument({
      m: { allOf: [object({ a: text }, { additionalProperties: text }), object({ at: dateTime })] },
    }),
    accepted: [],
    rejected: [{ m: { z: 1 } }],
  },
  {
    shape: 'T-96: a nullable object with own properties and an allOf object member',
    fixture: 'nullable-own-plus-member',
    root: 'Visit',
    document: visitDocument({ m: { type: ['object', 'null'], properties: { at: dateTime }, allOf: [{ properties: { b: dateTime } }] } }),
    accepted: [
      { wire: { m: null }, model: { m: null } },
      { wire: { m: { at: AT, b: B } }, model: { m: { at: new Date(AT), b: new Date(B) } } },
    ],
    rejected: [],
  },
  {
    shape: 'T-98: own properties plus an allOf $ref member',
    fixture: 'own-plus-reference',
    root: 'Visit',
    document: visitDocument(
      { m: { type: 'object', properties: { at: dateTime }, allOf: [ref('Base')] } },
      { Base: object({ name: text }) },
    ),
    accepted: [{ wire: { m: { at: AT, name: 'x' } }, model: { m: { at: new Date(AT), name: 'x' } } }],
    rejected: [],
  },
  {
    shape: 'T-98: an inline allOf of a $ref member and a properties member',
    fixture: 'inline-reference-plus-properties',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [ref('Base'), object({ at: dateTime })] } },
      { Base: object({ name: text }) },
    ),
    accepted: [{ wire: { m: { at: AT, name: 'x' } }, model: { m: { at: new Date(AT), name: 'x' } } }],
    rejected: [],
  },
  {
    shape: 'T-99a: two members declare the same property',
    fixture: 'same-name-members',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ at: dateTime }), object({ at: dateTime })] } }),
    accepted: [
      { wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } },
      { wire: { m: {} }, model: { m: {} } },
    ],
    rejected: [],
  },
  {
    shape: 'T-99b: an additionalProperties-only member beside a date property',
    fixture: 'additional-only-member',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [{ type: 'object', additionalProperties: text }, object({ at: dateTime })] } }),
    accepted: [
      { wire: { m: { at: AT, other: 'x' } }, model: { m: { at: new Date(AT), other: 'x' } } },
      { wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } },
    ],
    rejected: [{ m: { other: 1 } }],
  },
  {
    shape: 'strict b3: a date property, then an additionalProperties string member',
    fixture: 'additional-member-after-date',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ at: dateTime }), { type: 'object', additionalProperties: text }] } }),
    accepted: [{ wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } }],
    rejected: [{ m: { x: 1 } }],
  },
  {
    shape: 'T-99c: a member with properties and additionalProperties beside a date property',
    fixture: 'additional-plus-property',
    root: 'Visit',
    document: visitDocument({
      m: { allOf: [object({ a: text }, { additionalProperties: text }), object({ at: dateTime })] },
    }),
    accepted: [
      { wire: { m: { a: 'x', at: AT } }, model: { m: { a: 'x', at: new Date(AT) } } },
      { wire: { m: { at: AT, z: 'q' } }, model: { m: { at: new Date(AT), z: 'q' } } },
    ],
    rejected: [{ m: { z: 1 } }],
  },
  {
    shape: 'T-99: own additionalProperties dates plus an allOf properties member',
    fixture: 'own-additional-plus-member',
    root: 'Visit',
    document: visitDocument({
      m: { type: 'object', additionalProperties: dateTime, allOf: [object({ b: dateTime })] },
    }),
    accepted: [
      { wire: { m: { b: B } }, model: { m: { b: new Date(B) } } },
      { wire: { m: { x: AT, b: B } }, model: { m: { x: new Date(AT), b: new Date(B) } } },
    ],
    rejected: [{ m: { x: 1 } }],
  },
];

interface Built {
  readonly output: string;
  readonly Model: ModelConstructor;
  readonly construct: abstract new (values?: never) => object;
  readonly codec: ReturnType<typeof requireObjectCodec<Fields>>;
}

const scope = fileFixtureScope();

function builder(row: Row, validation: boolean): () => Promise<Built> {
  return onceShared(async () => {
    const output = path.join(createFixtureProject(scope, 'golem-composition-agreement-'), 'sdk');
    await generateMaterializedSdk(row.document, {
      output,
      name: 'Composition',
      profile: { mobx: false, validation, allowAny: false },
    });
    compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
    const models = requireRecord(
      await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
      `generated ${row.shape} models`,
    );
    const Model = models[`${row.root}Model`] as ModelConstructor;
    return {
      output,
      Model,
      construct: Model as unknown as abstract new (values?: never) => object,
      codec: requireObjectCodec<Fields>(generatedCodecIdFromRoot(output, row.root)),
    };
  });
}

/** Fields and wire values count an absent optional property and one set to undefined alike, as JSON does. */
function fieldsOf(model: object): Fields {
  return withoutUndefined({ ...model }) as Fields;
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (typeof value !== 'object' || value === null || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined).map(([name, field]) => [name, withoutUndefined(field)]),
  );
}

function asGenerated(model: object): GeneratedModel<unknown> {
  return model as GeneratedModel<unknown>;
}

/** A failure names the input that caused it. */
async function forInput(wire: Wire, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`input ${JSON.stringify(wire)}: ${reason}`, { cause: error });
  }
}

/** Model path and codec read and write the same fields for each accepted input. */
async function assertPathsAgree(built: Built, accepted: readonly Accepted[]): Promise<void> {
  for (const { wire, model } of accepted) {
    await forInput(wire, () => {
      const decoded = decodeGeneratedModel(built.Model, wire);
      assert.deepEqual(fieldsOf(decoded), model, 'model path decodes');
      assert.deepEqual(withoutUndefined(encodeGeneratedModel(asGenerated(decoded))), wire, 'model path encodes');
      const viaCodec = built.codec.fromWireFormat(wire, { construct: built.construct });
      assert.deepEqual(fieldsOf(viaCodec), model, 'codec decodes');
      assert.deepEqual(withoutUndefined(built.codec.toWireFormat(viaCodec)), wire, 'codec encodes');
    });
  }
}

/** The validator accepts each accepted input as a model and rejects each rejected input on the wire and as a model. */
async function assertValidatorJudges(built: Built, row: Row): Promise<void> {
  for (const { wire } of row.accepted) {
    await forInput(wire, async () => {
      assert.equal(await getValidator(decodeGeneratedModel(built.Model, wire)).validate(), true, 'validator accepts the model');
    });
  }
  for (const wire of row.rejected) {
    await forInput(wire, async () => {
      assertCodecRejects(built, wire);
      assert.equal(await modelPathAccepts(built, wire), false, 'model path rejects the input');
    });
  }
  for (const wire of row.rejectedOnWire ?? []) {
    await forInput(wire, () => assertCodecRejects(built, wire));
  }
}

function assertCodecRejects(built: Built, wire: Wire): void {
  assert.throws(
    () => built.codec.fromWireFormat(wire, { construct: built.construct }),
    (error: unknown): true => {
      assert.ok(error instanceof LibError, 'codec rejects the input');
      assert.equal(error.kind, LibErrorKind.Validation);
      return true;
    },
  );
}

/** The model path rejects an input when it cannot convert it, or when the validator rejects the decoded model. */
async function modelPathAccepts(built: Built, wire: Wire): Promise<boolean> {
  let model: object;
  try {
    model = decodeGeneratedModel(built.Model, wire);
  } catch (error) {
    if (error instanceof LibError && error.kind === LibErrorKind.Deserialization) return false;
    throw error;
  }
  return getValidator(model).validate();
}

for (const row of rows) {
  const checked = builder(row, true);
  const unchecked = builder(row, false);

  const fixture = row.fixture;
  if (fixture !== undefined) {
    test(`${row.shape}: the generated type`, async () => {
      const { output } = await checked();
      copyFixtureFile(output, `openapi/composition/${fixture}-types.ts`, 'row-types.ts');
      compileGeneratedSdk(output, [path.join(output, 'row-types.ts')], { strict: true, skipLibCheck: true, noEmit: true });
    });
  }

  test(`${row.shape}: validation on`, async () => {
    const built = await checked();
    await assertPathsAgree(built, row.accepted);
    await assertValidatorJudges(built, row);
  });

  if (row.accepted.length > 0) {
    test(`${row.shape}: validation off`, async () => {
      await assertPathsAgree(await unchecked(), row.accepted);
    });
  }
}

/** Shapes that no object can satisfy stop generation with a code that names the fix. */
const unsatisfiable: readonly { readonly shape: string; readonly code: string; readonly document: Record<string, unknown> }[] = [
  {
    shape: 'closed base and a component with a required own property',
    code: 'OPENAPI_COMPOSITION_UNSATISFIABLE',
    document: componentDocument('Derived', {
      Base: { type: 'object', additionalProperties: false, properties: { a: text } },
      Derived: { allOf: [ref('Base'), object({ b: dateTime }, { required: ['b'] })] },
    }),
  },
];

for (const { shape, code, document } of unsatisfiable) {
  test(`${shape}: generation fails with ${code}`, async t => {
    const output = path.join(createFixtureProject(t, 'golem-composition-unsatisfiable-'), 'sdk');
    await assert.rejects(
      generateMaterializedSdk(document, { output, name: 'Composition', profile: { mobx: false, validation: true, allowAny: false } }),
      (error: unknown): true => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(code));
        return true;
      },
    );
  });
}
