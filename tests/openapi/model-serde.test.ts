import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import { generatedModelSource } from './helpers.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { LibError, LibErrorKind, IssueRepresentation, IssueSource } from '@exprtlabs/golem/errors';
import type { GeneratedModel } from '@exprtlabs/golem/model';
import { getValidator } from '@exprtlabs/golem/validation';
import { generatedCodecIdFromRoot } from '../support/consumer.js';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  requireRecord,
} from './helpers.js';

type ChildInitLike = { id?: string; when?: Date };
interface ChildInstance {
  readonly id: string;
  readonly when?: Date;
}
interface ChildConstructor {
  new (values?: ChildInitLike): ChildInstance;
}
type EventInitLike = {
  when?: Date;
  maybeWhen?: Date | null;
  child?: ChildInstance | ChildInitLike;
  children?: readonly (ChildInstance | ChildInitLike)[];
  labels?: readonly string[];
};
interface EventInstance {
  readonly when: Date;
  readonly maybeWhen?: Date | null;
  readonly child: ChildInstance;
  readonly children?: readonly ChildInstance[];
}
interface EventConstructor {
  new (values?: EventInitLike): EventInstance;
}

interface DictionaryModelInstance {
  readonly [key: string]: unknown;
}

interface DictionaryModelConstructor {
  new (values?: Record<string, unknown>): DictionaryModelInstance;
}

function generated<Model extends object>(model: Model): Model & GeneratedModel<unknown> {
  return model as Model & GeneratedModel<unknown>;
}

function compileStandaloneModelSerdeSdk(output: string): void {
  compileGeneratedSdk(output, [], {
    strict: true,
    skipLibCheck: true,
  });
}

function modelSerdeDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'ModelSerde', version: '1' },
    paths: {
      '/events': {
        post: {
          operationId: 'createEvent',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
          responses: {
            201: {
              description: 'created',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
            },
            400: {
              description: 'typed problem',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Child: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string' },
            when: { type: 'string', format: 'date-time' },
          },
        },
        Event: {
          type: 'object',
          additionalProperties: false,
          required: ['when', 'child'],
          properties: {
            when: { type: 'string', format: 'date-time' },
            maybeWhen: { type: ['string', 'null'], format: 'date-time' },
            child: { $ref: '#/components/schemas/Child' },
            children: { type: 'array', items: { $ref: '#/components/schemas/Child' } },
            labels: { type: 'array', items: { type: 'string' } },
          },
        },
        Problem: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'message'],
          properties: { code: { type: 'string' }, message: { type: 'string' } },
        },
        BaseEvent: {
          type: 'object',
          additionalProperties: false,
          required: ['baseWhen'],
          properties: {
            baseWhen: { type: 'string', format: 'date-time' },
            baseLabel: { type: 'string' },
          },
        },
        DerivedEvent: {
          allOf: [
            { $ref: '#/components/schemas/BaseEvent' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['derivedWhen'],
              properties: {
                derivedWhen: { type: 'string', format: 'date-time' },
              },
            },
          ],
        },
        Dictionary: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            required: ['when', 'child'],
            properties: {
              when: { type: 'string', format: 'date-time' },
              child: { $ref: '#/components/schemas/Child' },
            },
          },
        },
        BaseDictionary: {
          type: 'object',
          additionalProperties: true,
          required: ['baseWhen'],
          properties: { baseWhen: { type: 'string', format: 'date-time' } },
        },
        DerivedDictionary: {
          allOf: [
            { $ref: '#/components/schemas/BaseDictionary' },
            {
              type: 'object',
              additionalProperties: {
                type: 'object',
                additionalProperties: false,
                required: ['when', 'child'],
                properties: {
                  when: { type: 'string', format: 'date-time' },
                  child: { $ref: '#/components/schemas/Child' },
                },
              },
              required: ['derivedWhen'],
              properties: { derivedWhen: { type: 'string', format: 'date-time' } },
            },
          ],
        },
      },
    },
  };
}

function discriminatedUnionSerdeDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'DiscriminatedSerde', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'getPet',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        PetBase: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string' },
          },
        },
        Cat: {
          allOf: [
            { $ref: '#/components/schemas/PetBase' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'name'],
              properties: {
                kind: { const: 'cat' },
                name: { type: 'string' },
              },
            },
          ],
        },
        Dog: {
          allOf: [
            { $ref: '#/components/schemas/PetBase' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'name'],
              properties: {
                kind: { const: 'dog' },
                name: { type: 'string' },
              },
            },
          ],
        },
        Pet: {
          oneOf: [
            { $ref: '#/components/schemas/Cat' },
            { $ref: '#/components/schemas/Dog' },
          ],
          discriminator: {
            propertyName: 'kind',
            mapping: {
              cat: '#/components/schemas/Cat',
              dog: '#/components/schemas/Dog',
            },
          },
        },
      },
    },
  };
}

async function assertNestedDateInheritedAndDictionaryConversions(
  models: Record<string, unknown>,
  label: string,
): Promise<void> {
  const ChildModel = models.ChildModel;
  const EventModel = models.EventModel;
  const DerivedEventModel = models.DerivedEventModel as unknown as DictionaryModelConstructor;
  const DictionaryModel = models.DictionaryModel as unknown as DictionaryModelConstructor;
  const DerivedDictionaryModel = models.DerivedDictionaryModel as unknown as DictionaryModelConstructor;
  assert.equal(typeof ChildModel, 'function');
  assert.equal(typeof EventModel, 'function');
  if (typeof ChildModel !== 'function' || typeof EventModel !== 'function') {
    throw new TypeError('Expected generated ChildModel and EventModel classes.');
  }

  const nestedChild = new (ChildModel as new (values?: ChildInitLike) => ChildInstance)({
    id: 'invalid-child',
    when: new Date(Number.NaN),
  });
  const invalidEvent = new (EventModel as new (values?: EventInitLike) => EventInstance)({
    when: new Date('2025-01-02T03:04:05Z'),
    child: nestedChild,
  });
  const validator = getValidator(invalidEvent);
  assert.equal(await validator.validate(), false, `${label} nested model validation rejects invalid Date`);
  assert.deepEqual(validator.issues.map(issue => issue.path), [['child', 'when']]);
  assert.equal(validator.errorsFor(['child', 'when']).length, 1, 'errorsFor matches a multi-segment nested path');

  const inherited = decodeGeneratedModel(DerivedEventModel as unknown as EventConstructor, {
    baseWhen: '2025-02-03T04:05:06Z',
    baseLabel: 'base',
    derivedWhen: '2025-03-04T05:06:07Z',
  }) as EventInstance & { readonly baseWhen: Date; readonly derivedWhen: Date };
  assert.ok(inherited.baseWhen instanceof Date, 'inherited Date field is decoded by derived deserialize');
  assert.ok(inherited.derivedWhen instanceof Date, 'derived Date field is decoded by derived deserialize');
  assert.deepEqual(encodeGeneratedModel(generated(inherited)), {
    baseWhen: '2025-02-03T04:05:06.000Z',
    baseLabel: 'base',
    derivedWhen: '2025-03-04T05:06:07.000Z',
  });

  const dictionary = decodeGeneratedModel(DictionaryModel as unknown as DictionaryModelConstructor, {
    first: {
      when: '2025-04-05T06:07:08Z',
      child: { id: 'dictionary-child' },
    },
  });
  const dictionaryEntry = (dictionary.first as Record<string, unknown>);
  assert.ok(dictionaryEntry.when instanceof Date, 'dictionary Date value is decoded');
  assert.ok(dictionaryEntry.child instanceof ChildModel, 'dictionary nested model is decoded');
  assert.deepEqual(encodeGeneratedModel(generated(dictionary)), {
    first: { when: '2025-04-05T06:07:08.000Z', child: { id: 'dictionary-child' } },
  });

  const derivedDictionary = decodeGeneratedModel(DerivedDictionaryModel as unknown as DictionaryModelConstructor, {
    baseWhen: '2025-06-07T08:09:10Z',
    derivedWhen: '2025-07-08T09:10:11Z',
    entry: {
      when: '2025-08-09T10:11:12Z',
      child: { id: 'derived-dictionary-child' },
    },
  });
  assert.ok(derivedDictionary.baseWhen instanceof Date, 'inherited declared field remains a Date');
  assert.ok(derivedDictionary.derivedWhen instanceof Date, 'derived declared field remains a Date');
  const derivedEntry = derivedDictionary.entry as Record<string, unknown>;
  assert.ok(derivedEntry.when instanceof Date, 'derived dictionary Date value is decoded');
  assert.ok(derivedEntry.child instanceof ChildModel, 'derived dictionary nested model is decoded');
  assert.deepEqual(encodeGeneratedModel(generated(derivedDictionary)), {
    baseWhen: '2025-06-07T08:09:10.000Z',
    derivedWhen: '2025-07-08T09:10:11.000Z',
    entry: { when: '2025-08-09T10:11:12.000Z', child: { id: 'derived-dictionary-child' } },
  });
}

test('checked model serde validates wire before construction, converts nested nullable values once, and preserves typed HTTP errors', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-model-serde-runtime-'), 'sdk');
  await generateMaterializedSdk(modelSerdeDocument(), {
    output,
    name: 'ModelSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  // Nested Init/Fields/JSON contracts: Date is the runtime value, the wire contract stays a string.
  copyFixtureFile(output, "openapi/model-serde/model-serde-types.ts", "model-serde-types.ts");
  compileGeneratedSdk(output, [path.join(output, 'model-serde-types.ts')], {
    strict: true,
    skipLibCheck: true,
  });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated models',
  );
  assert.equal(typeof models.ChildModel, 'function');
  assert.equal(typeof models.EventModel, 'function');
  if (typeof models.ChildModel !== 'function' || typeof models.EventModel !== 'function') {
    throw new TypeError('Expected generated ChildModel and EventModel classes.');
  }
  const ChildModel = models.ChildModel as unknown as ChildConstructor;
  const EventModel = models.EventModel as unknown as EventConstructor;

  const date = new Date('0001-01-01T00:00:00.123Z');
  const child = new ChildModel({ id: 'child' });
  const constructorModel = new EventModel({ when: date, maybeWhen: null, child });
  assert.equal(constructorModel.when, date, 'constructors accept runtime Date values without decoding');
  assert.equal(constructorModel.child, child, 'constructors preserve existing nested model instances');
  assert.equal(constructorModel.maybeWhen, null);

  const countedChild = new ChildModel({ id: 'counted' });
  const model = new EventModel({
    when: date,
    maybeWhen: null,
    child: countedChild,
    children: [countedChild],
    labels: ['one', 'two'],
  });
  const wire = encodeGeneratedModel(generated(model)) as Record<string, unknown>;
  assert.equal(
    JSON.stringify(wire),
    '{"when":"0001-01-01T00:00:00.123Z","maybeWhen":null,"child":{"id":"counted"},"children":[{"id":"counted"}],"labels":["one","two"]}',
    'OpenAPI models use the same detached JSON serialization as object serialization',
  );
  assert.equal(wire.when, '0001-01-01T00:00:00.123Z');
  assert.equal(wire.maybeWhen, null);
  assert.deepEqual(wire.child, { id: 'counted' });
  assert.deepEqual(wire.children, [{ id: 'counted' }]);

  const parsed = decodeGeneratedModel(EventModel, {
    when: '0099-12-31T23:59:59.9-05:00',
    maybeWhen: null,
    child,
    children: [child],
  }) as EventInstance;
  assert.equal(parsed.when.toISOString(), '0100-01-01T04:59:59.900Z');
  assert.equal(parsed.maybeWhen, null);
  assert.equal(parsed.child, child, 'deserialize preserves an already-converted nested model');
  assert.equal(parsed.children?.[0], child, 'array conversion preserves an already-converted nested model');
  assert.deepEqual(encodeGeneratedModel(generated(parsed)), {
    when: '0100-01-01T04:59:59.900Z',
    maybeWhen: null,
    child: { id: 'child' },
    children: [{ id: 'child' }],
  });

  const parsedPlain = decodeGeneratedModel(EventModel, {
    when: '2025-01-02T03:04:05Z',
    child: { id: 'plain', when: '2025-01-02T03:04:05Z' },
  }) as EventInstance;
  assert.ok(parsedPlain.child instanceof ChildModel);
  assert.ok(parsedPlain.child.when instanceof Date);

  const serialized = encodeGeneratedModel(generated(model));
  assert.deepEqual(serialized, wire);
  const deserialized = decodeGeneratedModel(EventModel, serialized) as EventInstance;
  assert.ok(deserialized.when instanceof Date);
  assert.equal(deserialized.when.toISOString(), '0001-01-01T00:00:00.123Z');
  assert.equal(deserialized.child instanceof ChildModel, true);

  let constructed = 0;
  class CountingEvent extends (EventModel as unknown as EventConstructor) {
    constructor(values?: EventInitLike) {
      constructed++;
      super(values);
    }
  }
  assert.throws(
    () => requireObjectCodec(generatedCodecIdFromRoot(output, 'Event')).fromWireFormat(
      { when: 'not-a-date', child: { id: 'child' } },
      { construct: CountingEvent as unknown as abstract new (values?: never) => object },
    ),
    (error: unknown) => {
      assert.ok(error instanceof LibError);
      assert.equal(error.kind, LibErrorKind.Validation);
      assert.equal(error.issues[0]?.source, IssueSource.OpenAPI);
      assert.equal(error.issues[0]?.representation, IssueRepresentation.Wire);
      return true;
    },
  );
  assert.equal(constructed, 0, 'invalid wire data is rejected before the model constructor runs');

  const clientModule = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'generated client',
  );
  const Client = clientModule.ModelSerdeClient;
  assert.equal(typeof Client, 'function');
  const problem = { code: 'EVENT_INVALID', message: 'event rejected by the service' };
  const client = new (Client as new (options: Record<string, unknown>) => {
    createEvent(): { execute(input: unknown): Promise<unknown> };
  })({
    baseUrl: 'https://service.example.test',
    fetchImpl: async () => new Response(JSON.stringify(problem), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const response = await client.createEvent().execute({ body: { when: '2025-01-02T03:04:05Z', child: { id: 'child' } } });
  assert.deepEqual(response, {
    matched: 'status',
    status: 400,
    contentType: 'application/json',
    body: problem,
    headers: {},
  });

  await assertNestedDateInheritedAndDictionaryConversions(models, 'JIT');
});

test('generated nested Date, inherited, and dictionary conversions work in a standalone SDK', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-model-serde-aot-'), 'sdk');
  await generateMaterializedSdk(modelSerdeDocument(), {
    output,
    name: 'ModelSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  compileStandaloneModelSerdeSdk(output);
  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'standalone generated models',
  );
  await assertNestedDateInheritedAndDictionaryConversions(models, 'standalone');
});

test('generated discriminated unions infer abstract, concrete, and handwritten serde classes', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-union-serde-'), 'sdk');
  const result = await generateMaterializedSdk(discriminatedUnionSerdeDocument(), {
    output,
    name: 'DiscriminatedSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  const models = generatedModelSource(result.artifacts);
  assert.doesNotMatch(models, /\b(?:fromJSON|toJSON)\b/);

  const consumer = path.join(output, 'union-types.ts');
  copyFixtureFile(output, "openapi/model-serde/union-types.ts", "union-types.ts");
  compileGeneratedSdk(output, [consumer], { strict: true, skipLibCheck: true });

  const modelExports = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated discriminated union models',
  );
  const CatModel = modelExports.CatModel as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const HandwrittenCat = class extends CatModel {
    readonly marker = true;
  };
  const cat = decodeGeneratedModel(CatModel, { kind: 'cat', name: 'Miso' });
  const handwritten = decodeGeneratedModel(HandwrittenCat, { kind: 'cat', name: 'Miso' });
  assert.ok(handwritten instanceof HandwrittenCat, 'a handwritten concrete subclass is constructed directly');
  assert.ok(handwritten instanceof CatModel);
  assert.equal((handwritten as { readonly marker: boolean }).marker, true);
  assert.deepEqual(encodeGeneratedModel(generated(handwritten)), { kind: 'cat', name: 'Miso' });
  assert.equal('fromJSON' in (modelExports.PetModel as object), false);
  assert.equal('fromJSON' in (modelExports.CatModel as object), false);
  assert.equal('toJSON' in (cat as object), false);
});
