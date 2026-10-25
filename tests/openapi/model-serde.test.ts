import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
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
        // An open base, closed on each derived component by unevaluatedProperties: false.
        BaseEvent: {
          type: 'object',
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
              required: ['derivedWhen'],
              properties: {
                derivedWhen: { type: 'string', format: 'date-time' },
              },
            },
          ],
          unevaluatedProperties: false,
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
              // Strict JSON Schema: this member's additionalProperties judges every name it does not list, so it lists the
              // inherited baseWhen too.
              properties: {
                baseWhen: { type: 'string', format: 'date-time' },
                derivedWhen: { type: 'string', format: 'date-time' },
              },
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
        // An open base, and unevaluatedProperties: false on each derived component: strict JSON Schema closes Cat and Dog
        // to the base and own names. A closed base would reject the required own name.
        PetBase: {
          type: 'object',
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
              required: ['kind', 'name'],
              properties: {
                kind: { const: 'cat' },
                name: { type: 'string' },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        Dog: {
          allOf: [
            { $ref: '#/components/schemas/PetBase' },
            {
              type: 'object',
              required: ['kind', 'name'],
              properties: {
                kind: { const: 'dog' },
                name: { type: 'string' },
              },
            },
          ],
          unevaluatedProperties: false,
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

function tupleSerdeDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'TupleSerde', version: '1' },
    paths: {
      '/itineraries': {
        get: {
          operationId: 'getItinerary',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Itinerary' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Itinerary: {
          type: 'object',
          additionalProperties: false,
          required: ['stops', 'leg', 'held'],
          properties: {
            stops: {
              type: 'array',
              prefixItems: [{ type: 'string' }],
              items: { type: 'string', format: 'date-time' },
            },
            leg: {
              type: 'array',
              prefixItems: [{ type: 'string' }, { type: 'string', format: 'date-time' }],
              items: false,
            },
            held: {
              type: 'array',
              prefixItems: [{ type: 'string', format: 'date-time' }],
              items: false,
              allOf: [{ minItems: 1 }],
            },
          },
        },
      },
    },
  };
}

function sequenceSerdeDocument(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'SequenceSerde', version: '1' },
    paths: {
      '/visits': {
        get: {
          operationId: 'getVisit',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Visit' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Visit: {
          type: 'object',
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
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

test('generated nested Date, inherited, and dictionary conversions work in a standalone SDK', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-model-serde-aot-'), 'sdk');
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
    'standalone generated models',
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

  await assertNestedDateInheritedAndDictionaryConversions(models, 'standalone');
});

test('generated discriminated unions infer abstract, concrete, and handwritten serde classes', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-union-serde-'), 'sdk');
  await generateMaterializedSdk(discriminatedUnionSerdeDocument(), {
    output,
    name: 'DiscriminatedSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });

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
  assert.deepEqual(encodeGeneratedModel(generated(cat)), { kind: 'cat', name: 'Miso' });
});

test('a tuple field converts each item by its own schema: the prefix stays a string and the rest items are Dates', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-tuple-serde-'), 'sdk');
  await generateMaterializedSdk(tupleSerdeDocument(), {
    output,
    name: 'TupleSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/tuple-types.ts', 'tuple-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'tuple-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated tuple models',
  );
  const ItineraryModel = models.ItineraryModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  const itinerary = decodeGeneratedModel(ItineraryModel, {
    stops: ['label', '2024-05-06T07:08:09.000Z'],
    leg: ['gate', '2024-05-07T08:09:10.000Z'],
    held: ['2024-05-08T09:10:11.000Z'],
  });
  assert.deepEqual(itinerary.stops, ['label', new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(itinerary.leg, ['gate', new Date('2024-05-07T08:09:10.000Z')]);
  assert.deepEqual(itinerary.held, [new Date('2024-05-08T09:10:11.000Z')]);
  assert.deepEqual(encodeGeneratedModel(generated(itinerary)), {
    stops: ['label', '2024-05-06T07:08:09.000Z'],
    leg: ['gate', '2024-05-07T08:09:10.000Z'],
    held: ['2024-05-08T09:10:11.000Z'],
  });

  assert.throws(
    () => decodeGeneratedModel(ItineraryModel, { stops: ['label', '2024-05-06T07:08:09.000Z', 'not a date'], leg: [], held: [] }),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.deepEqual(error.issues[0]?.path, ['stops', 2]);
      return true;
    },
  );
});

test('an array field with an allOf sibling converts its items to Dates and is typed Date[]', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-array-allof-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    visits: {
      type: 'array',
      items: { type: 'string', format: 'date-time' },
      allOf: [{ minItems: 1 }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/array-types.ts', 'array-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'array-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated array models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  const visit = decodeGeneratedModel(VisitModel, { visits: ['2024-05-06T07:08:09.000Z'] });
  assert.deepEqual(visit.visits, [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(encodeGeneratedModel(generated(visit)), { visits: ['2024-05-06T07:08:09.000Z'] });
});

test('an SDK model with a property that has no type generates under the default allowAny and accepts any value', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-untyped-property-'), 'sdk');
  await generateMaterializedSdk({
    openapi: '3.1.0',
    info: { title: 'Untyped', version: '1' },
    paths: {
      '/envelopes': {
        get: {
          operationId: 'getEnvelope',
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
          },
        },
      },
    },
    components: {
      schemas: {
        Envelope: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'payload'],
          properties: { id: { type: 'string' }, payload: { description: 'Any JSON value' } },
        },
      },
    },
  }, {
    output,
    name: 'Untyped',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated untyped models',
  );
  const EnvelopeModel = models.EnvelopeModel as unknown as new (values: { id: string; payload: unknown }) => object;
  assert.equal(await getValidator(new EnvelopeModel({ id: 'a', payload: { nested: [1] } })).validate(), true);
  assert.equal(await getValidator(new EnvelopeModel({ id: 'a', payload: 'text' })).validate(), true);
  assert.equal(await getValidator(new EnvelopeModel({ id: 'a', payload: 7 })).validate(), true);
});

test('an array or tuple field with no type or a nullable type converts like type array, and null stays null', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-sequence-shapes-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    maybeVisits: { type: ['array', 'null'], items: { type: 'string', format: 'date-time' } },
    untypedVisits: { items: { type: 'string', format: 'date-time' } },
    maybeLeg: {
      type: ['array', 'null'],
      prefixItems: [{ type: 'string' }, { type: 'string', format: 'date-time' }],
      items: false,
    },
    untypedLeg: {
      prefixItems: [{ type: 'string' }, { type: 'string', format: 'date-time' }],
      items: false,
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/sequence-shape-types.ts', 'sequence-shape-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'sequence-shape-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated sequence models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  const visit = decodeGeneratedModel(VisitModel, {
    maybeVisits: ['2024-05-06T07:08:09.000Z'],
    untypedVisits: ['2024-05-07T08:09:10.000Z'],
    maybeLeg: ['gate', '2024-05-08T09:10:11.000Z'],
    untypedLeg: ['door', '2024-05-09T10:11:12.000Z'],
  });
  assert.deepEqual(visit.maybeVisits, [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(visit.untypedVisits, [new Date('2024-05-07T08:09:10.000Z')]);
  assert.deepEqual(visit.maybeLeg, ['gate', new Date('2024-05-08T09:10:11.000Z')]);
  assert.deepEqual(visit.untypedLeg, ['door', new Date('2024-05-09T10:11:12.000Z')]);
  assert.deepEqual(encodeGeneratedModel(generated(visit)), {
    maybeVisits: ['2024-05-06T07:08:09.000Z'],
    untypedVisits: ['2024-05-07T08:09:10.000Z'],
    maybeLeg: ['gate', '2024-05-08T09:10:11.000Z'],
    untypedLeg: ['door', '2024-05-09T10:11:12.000Z'],
  });

  const absent = decodeGeneratedModel(VisitModel, {
    maybeVisits: null,
    untypedVisits: [],
    maybeLeg: null,
    untypedLeg: [],
  });
  assert.equal(absent.maybeVisits, null);
  assert.equal(absent.maybeLeg, null);
});

test('allOf members decide an array field: constraint-only and restating members change nothing, a converting member wins', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-array-allof-members-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    restatingMember: {
      type: 'array',
      items: { type: 'string', format: 'date-time' },
      allOf: [{ items: { maxLength: 30 } }],
    },
    restatedByMember: {
      allOf: [{ type: 'array', items: { type: 'string', format: 'date-time' } }, { items: { maxLength: 30 } }],
    },
    membersCarry: {
      allOf: [{ type: 'array', items: { type: 'string', format: 'date-time' } }],
    },
    describedMember: {
      type: 'array',
      items: { type: 'string', format: 'date-time' },
      allOf: [{ description: 'when the visits happened' }],
    },
    bareArrayMember: {
      type: 'array',
      items: { type: 'string', format: 'date-time' },
      allOf: [{ type: 'array' }],
    },
    convertingMemberWins: {
      type: 'array',
      items: { type: 'string' },
      allOf: [{ type: 'array', items: { type: 'string', format: 'date-time' } }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-sequence-types.ts', 'allof-sequence-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-sequence-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated allOf array models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  const visit = decodeGeneratedModel(VisitModel, {
    restatingMember: ['2024-05-06T07:08:09.000Z'],
    restatedByMember: ['2024-05-07T08:09:10.000Z'],
    membersCarry: ['2024-05-08T09:10:11.000Z'],
    describedMember: ['2024-05-09T10:11:12.000Z'],
    bareArrayMember: ['2024-05-10T11:12:13.000Z'],
    convertingMemberWins: ['2024-05-11T12:13:14.000Z'],
  });
  assert.deepEqual(visit.restatingMember, [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(visit.restatedByMember, [new Date('2024-05-07T08:09:10.000Z')]);
  assert.deepEqual(visit.membersCarry, [new Date('2024-05-08T09:10:11.000Z')]);
  assert.deepEqual(visit.describedMember, [new Date('2024-05-09T10:11:12.000Z')]);
  assert.deepEqual(visit.bareArrayMember, [new Date('2024-05-10T11:12:13.000Z')]);
  assert.deepEqual(visit.convertingMemberWins, [new Date('2024-05-11T12:13:14.000Z')]);
});

test('a oneOf of a scalar and a nullable array or tuple converts the sequence, keeps the scalar and keeps null', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-scalar-or-nullable-sequence-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    plainOrDates: {
      oneOf: [{ type: 'string' }, { type: ['array', 'null'], items: { type: 'string', format: 'date-time' } }],
    },
    plainOrLeg: {
      oneOf: [
        { type: 'string' },
        { type: ['array', 'null'], prefixItems: [{ type: 'string', format: 'date-time' }], items: false },
      ],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/scalar-or-sequence-types.ts', 'scalar-or-sequence-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'scalar-or-sequence-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated scalar-or-sequence models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  const scalars = decodeGeneratedModel(VisitModel, { plainOrDates: 'plain', plainOrLeg: 'plain' });
  assert.equal(scalars.plainOrDates, 'plain');
  assert.equal(scalars.plainOrLeg, 'plain');
  const sequences = decodeGeneratedModel(VisitModel, {
    plainOrDates: ['2024-05-06T07:08:09.000Z'],
    plainOrLeg: ['2024-05-07T08:09:10.000Z'],
  });
  assert.deepEqual(sequences.plainOrDates, [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(sequences.plainOrLeg, [new Date('2024-05-07T08:09:10.000Z')]);
  const nulls = decodeGeneratedModel(VisitModel, { plainOrDates: null, plainOrLeg: null });
  assert.equal(nulls.plainOrDates, null);
  assert.equal(nulls.plainOrLeg, null);
});

test('a nullable array field with an allOf minItems keeps null, rejects an empty array and accepts dates', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-nullable-array-allof-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    visits: {
      type: ['array', 'null'],
      items: { type: 'string', format: 'date-time' },
      allOf: [{ minItems: 1 }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/nullable-array-types.ts', 'nullable-array-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'nullable-array-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated nullable array models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  assert.equal(decodeGeneratedModel(VisitModel, { visits: null }).visits, null);
  assert.deepEqual(
    decodeGeneratedModel(VisitModel, { visits: ['2024-05-06T07:08:09.000Z'] }).visits,
    [new Date('2024-05-06T07:08:09.000Z')],
  );
  assert.throws(
    () => requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit')).fromWireFormat(
      { visits: [] },
      { construct: VisitModel as unknown as abstract new (values?: never) => object },
    ),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.equal(error.kind, LibErrorKind.Validation);
      return true;
    },
  );
});

test('an object field whose allOf members only add constraints converts by its own properties and keeps the constraints', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-constraint-allof-object-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    window: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ minProperties: 1 }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-object-types.ts', 'allof-object-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-object-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated constraint-only allOf object models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  const visit = decodeGeneratedModel(VisitModel, { window: { at: '2024-05-06T07:08:09.000Z' } });
  assert.deepEqual(visit.window, { at: new Date('2024-05-06T07:08:09.000Z') });
  assert.throws(
    () => requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit')).fromWireFormat(
      { window: {} },
      { construct: VisitModel as unknown as abstract new (values?: never) => object },
    ),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.equal(error.kind, LibErrorKind.Validation);
      return true;
    },
  );
});

test('a oneOf field whose allOf members only add constraints converts by its own oneOf', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-constraint-allof-oneof-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    either: {
      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
      allOf: [{ description: 'when the visit happened' }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-oneof-types.ts', 'allof-oneof-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-oneof-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated constraint-only allOf oneOf models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  assert.deepEqual(
    decodeGeneratedModel(VisitModel, { either: '2024-05-07T08:09:10.000Z' }).either,
    new Date('2024-05-07T08:09:10.000Z'),
  );
  assert.equal(decodeGeneratedModel(VisitModel, { either: null }).either, null);
});

test('a nullable object field admits null and converts its properties', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-nullable-object-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    window: {
      type: ['object', 'null'],
      properties: { at: { type: 'string', format: 'date-time' } },
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/nullable-object-types.ts', 'nullable-object-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'nullable-object-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated nullable object models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.equal(decodeGeneratedModel(VisitModel, { window: null }).window, null);
  assert.deepEqual(
    decodeGeneratedModel(VisitModel, { window: { at: '2024-05-06T07:08:09.000Z' } }).window,
    { at: new Date('2024-05-06T07:08:09.000Z') },
  );
  assert.doesNotThrow(() => codec.fromWireFormat({ window: null }, { construct }));
});

test('a nullable object field with a constraint-only allOf admits null and still rejects an empty object', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-nullable-object-allof-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    window: {
      type: ['object', 'null'],
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ minProperties: 1 }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/nullable-object-types.ts', 'nullable-object-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'nullable-object-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated nullable object allOf models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.equal(decodeGeneratedModel(VisitModel, { window: null }).window, null);
  assert.doesNotThrow(() => codec.fromWireFormat({ window: null }, { construct }));
  assert.throws(
    () => codec.fromWireFormat({ window: {} }, { construct }),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.equal(error.kind, LibErrorKind.Validation);
      return true;
    },
  );
});

test('a field that references a nullable component object is typed with | null and admits null', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-nullable-reference-'), 'sdk');
  const document = sequenceSerdeDocument({ pet: { $ref: '#/components/schemas/Pet' } }) as {
    components: { schemas: Record<string, Record<string, unknown>> };
  };
  document.components.schemas.Pet = {
    type: ['object', 'null'],
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  };
  await generateMaterializedSdk(document, {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/nullable-reference-types.ts', 'nullable-reference-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'nullable-reference-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated nullable reference models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.equal(decodeGeneratedModel(VisitModel, { pet: null }).pet, null);
  assert.doesNotThrow(() => codec.fromWireFormat({ pet: null }, { construct }));
  assert.equal(JSON.stringify(decodeGeneratedModel(VisitModel, { pet: { name: 'Miso' } }).pet), '{"name":"Miso"}');
});

test('a field that references a nullable component with a date-time property decodes, validates and encodes it', async t => {
  // protects: T-95 nullable component with a date-time property validates its wire form
  const output = path.join(createFixtureProject(t, 'golem-openapi-nullable-date-reference-'), 'sdk');
  const document = sequenceSerdeDocument({ pet: { $ref: '#/components/schemas/Pet' } }) as {
    components: { schemas: Record<string, Record<string, unknown>> };
  };
  document.components.schemas.Pet = {
    type: ['object', 'null'],
    required: ['name'],
    properties: { name: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
  };
  await generateMaterializedSdk(document, {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  compileStandaloneModelSerdeSdk(output);

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated nullable component date models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec<Record<string, unknown>>(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  const decoded = codec.fromWireFormat({ pet: { name: 'Miso', at: '2024-05-06T07:08:09.000Z' } }, { construct });
  assert.deepEqual({ ...(decoded.pet as object) }, { name: 'Miso', at: new Date('2024-05-06T07:08:09.000Z') });
  assert.deepEqual(codec.toWireFormat(decoded), { pet: { name: 'Miso', at: '2024-05-06T07:08:09.000Z' } });
  assert.equal(codec.fromWireFormat({ pet: null }, { construct }).pet, null);
  assert.throws(
    () => codec.fromWireFormat({ pet: { name: 'Miso', at: 'yesterday' } }, { construct }),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.equal(error.kind, LibErrorKind.Validation);
      return true;
    },
  );
});

for (const validation of [true, false]) test(`an object field with its own properties and an allOf member that adds properties types and converts both alike (validation ${validation})`, async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-allof-member-properties-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    merged: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ properties: { b: { type: 'string', format: 'date-time' } } }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-members-types.ts', 'allof-members-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-members-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated allOf member properties models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  assert.deepEqual(
    decodeGeneratedModel(VisitModel, { merged: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } }).merged,
    { at: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') },
  );

  const codec = requireObjectCodec<{ merged: unknown }>(generatedCodecIdFromRoot(output, 'Visit'));
  const wire = { merged: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } };
  const model = codec.fromWireFormat(wire, { construct: VisitModel as unknown as abstract new (values?: never) => object });
  assert.deepEqual(model.merged, { at: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') });
  assert.deepEqual(codec.toWireFormat(model), wire);
  const partial = [{}, { at: '2024-05-06T07:08:09.000Z' }, { b: '2024-05-07T08:09:10.000Z' }];
  for (const part of partial) {
    const partialModel = codec.fromWireFormat({ merged: part }, { construct: VisitModel as unknown as abstract new (values?: never) => object });
    assert.deepEqual(codec.toWireFormat(partialModel), { merged: part });
  }
});

test('a name in the required list of an allOf member is required in the field type and by the validator', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-allof-required-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    window: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ required: ['at'] }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-required-types.ts', 'allof-required-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-required-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated allOf required models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.deepEqual(
    decodeGeneratedModel(VisitModel, { window: { at: '2024-05-06T07:08:09.000Z' } }).window,
    { at: new Date('2024-05-06T07:08:09.000Z') },
  );
  assert.throws(
    () => codec.fromWireFormat({ window: {} }, { construct }),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.equal(error.kind, LibErrorKind.Validation);
      return true;
    },
  );
});

for (const validation of [true, false]) test(`an allOf of object members is typed by the same members that convert it (validation ${validation})`, async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-allof-object-members-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    members: {
      allOf: [
        { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } },
        { type: 'object', properties: { b: { type: 'string', format: 'date-time' } } },
      ],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-object-members-types.ts', 'allof-object-members-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-object-members-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated allOf object member models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;

  assert.deepEqual(
    decodeGeneratedModel(VisitModel, { members: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } }).members,
    { at: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') },
  );

  const codec = requireObjectCodec<{ members: unknown }>(generatedCodecIdFromRoot(output, 'Visit'));
  const wire = { members: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } };
  const model = codec.fromWireFormat(wire, { construct: VisitModel as unknown as abstract new (values?: never) => object });
  assert.deepEqual(model.members, { at: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') });
  assert.deepEqual(codec.toWireFormat(model), wire);
  const partial = [{}, { at: '2024-05-06T07:08:09.000Z' }, { b: '2024-05-07T08:09:10.000Z' }];
  for (const part of partial) {
    const partialModel = codec.fromWireFormat({ members: part }, { construct: VisitModel as unknown as abstract new (values?: never) => object });
    assert.deepEqual(codec.toWireFormat(partialModel), { members: part });
  }
});

test('an object field with own properties and an allOf reference to a model still generates and is typed by its own properties', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-allof-own-reference-'), 'sdk');
  const document = sequenceSerdeDocument({
    based: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ $ref: '#/components/schemas/Base' }],
    },
  }) as { components: { schemas: Record<string, Record<string, unknown>> } };
  document.components.schemas.Base = { type: 'object', properties: { name: { type: 'string' } } };
  await generateMaterializedSdk(document, {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-own-reference-types.ts', 'allof-own-reference-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-own-reference-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated own properties and allOf reference models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.doesNotThrow(() => codec.fromWireFormat({ based: { name: 'Miso' } }, { construct }));
});

test('a nullable object field whose allOf member adds properties still generates', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-nullable-allof-members-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    window: {
      type: ['object', 'null'],
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ properties: { b: { type: 'string', format: 'date-time' } } }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/nullable-allof-members-types.ts', 'nullable-allof-members-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'nullable-allof-members-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated nullable allOf member models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.doesNotThrow(() => codec.fromWireFormat({ window: { b: '2024-05-07T08:09:10.000Z' } }, { construct }));
});

test('a discriminated oneOf with a nullable component variant still generates and converts its variants', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-oneof-nullable-variant-'), 'sdk');
  const document = sequenceSerdeDocument({
    pet: {
      oneOf: [{ $ref: '#/components/schemas/Dog' }, { $ref: '#/components/schemas/Cat' }],
      discriminator: {
        propertyName: 'kind',
        mapping: { dog: '#/components/schemas/Dog', cat: '#/components/schemas/Cat' },
      },
    },
  }) as { components: { schemas: Record<string, Record<string, unknown>> } };
  document.components.schemas.Dog = {
    type: ['object', 'null'],
    required: ['kind', 'name'],
    properties: { kind: { const: 'dog' }, name: { type: 'string' } },
  };
  document.components.schemas.Cat = {
    type: 'object',
    required: ['kind', 'name'],
    properties: { kind: { const: 'cat' }, name: { type: 'string' } },
  };
  await generateMaterializedSdk(document, {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/oneof-discriminated-nullable-types.ts', 'oneof-discriminated-nullable-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'oneof-discriminated-nullable-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated discriminated nullable variant models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.equal(JSON.stringify(decodeGeneratedModel(VisitModel, { pet: { kind: 'cat', name: 'Miso' } }).pet), '{"kind":"cat","name":"Miso"}');
  assert.doesNotThrow(() => codec.fromWireFormat({ pet: { kind: 'dog', name: 'Rex' } }, { construct }));
});

test('a oneOf variant that references a nullable component admits null and is typed with | null', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-oneof-nullable-reference-'), 'sdk');
  const document = sequenceSerdeDocument({
    either: { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'string' }] },
  }) as { components: { schemas: Record<string, Record<string, unknown>> } };
  document.components.schemas.Pet = { type: ['object', 'null'], properties: { name: { type: 'string' } } };
  await generateMaterializedSdk(document, {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/oneof-nullable-reference-types.ts', 'oneof-nullable-reference-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'oneof-nullable-reference-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated oneOf nullable reference models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.doesNotThrow(() => codec.fromWireFormat({ either: { name: 'Miso' } }, { construct }));
  assert.equal(decodeGeneratedModel(VisitModel, { either: null }).either, null);
  assert.equal((codec.fromWireFormat({ either: null }, { construct }) as { either: unknown }).either, null);
});

for (const validation of [true, false]) for (const petType of ['object', ['object', 'null']]) {
  test(`a oneOf of a ${Array.isArray(petType) ? 'nullable ' : ''}component and a string decodes and encodes each branch by its type (validation ${validation})`, async t => {
    // protects: T-97 oneOf of a model reference and a string keeps both branches
    const output = path.join(createFixtureProject(t, 'golem-openapi-oneof-reference-string-'), 'sdk');
    const document = sequenceSerdeDocument({
      either: { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'string' }] },
    }) as { components: { schemas: Record<string, Record<string, unknown>> } };
    document.components.schemas.Pet = { type: petType, required: ['name'], properties: { name: { type: 'string' } } };
    await generateMaterializedSdk(document, {
      output,
      name: 'SequenceSerde',
      profile: { mobx: false, validation, allowAny: false },
    });
    compileStandaloneModelSerdeSdk(output);

    const models = requireRecord(
      await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
      'generated oneOf reference and string models',
    );
    const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
    const codec = requireObjectCodec<Record<string, unknown>>(generatedCodecIdFromRoot(output, 'Visit'));
    const construct = VisitModel as unknown as abstract new (values?: never) => object;

    const text = codec.fromWireFormat({ either: 'abc' }, { construct });
    assert.equal(text.either, 'abc');
    assert.deepEqual(codec.toWireFormat(text), { either: 'abc' });
    const pet = codec.fromWireFormat({ either: { name: 'Miso' } }, { construct });
    assert.ok(pet.either instanceof (models.PetModel as new () => object));
    assert.deepEqual(codec.toWireFormat(pet), { either: { name: 'Miso' } });
  });
}

for (const validation of [true, false]) test(`a oneOf of a nullable component with a date-time property and a string decodes the date and admits null (validation ${validation})`, async t => {
  // protects: T-97 oneOf variant of a nullable component keeps the component's date-time conversion
  const output = path.join(createFixtureProject(t, 'golem-openapi-oneof-nullable-date-'), 'sdk');
  const document = sequenceSerdeDocument({
    either: { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'string' }] },
  }) as { components: { schemas: Record<string, Record<string, unknown>> } };
  document.components.schemas.Pet = {
    type: ['object', 'null'],
    required: ['name'],
    properties: { name: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
  };
  await generateMaterializedSdk(document, {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation, allowAny: false },
  });
  compileStandaloneModelSerdeSdk(output);

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated oneOf nullable date models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec<Record<string, unknown>>(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  const pet = codec.fromWireFormat({ either: { name: 'Miso', at: '2024-05-06T07:08:09.000Z' } }, { construct });
  assert.deepEqual({ ...(pet.either as object) }, { name: 'Miso', at: new Date('2024-05-06T07:08:09.000Z') });
  assert.deepEqual(codec.toWireFormat(pet), { either: { name: 'Miso', at: '2024-05-06T07:08:09.000Z' } });
  assert.equal(codec.fromWireFormat({ either: null }, { construct }).either, null);
  assert.equal(codec.fromWireFormat({ either: 'abc' }, { construct }).either, 'abc');
});

test(`an allOf of an additionalProperties member and a properties member converts every name by the merged object (validation false)`, async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-allof-additional-members-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    members: {
      allOf: [
        { type: 'object', additionalProperties: { type: 'string', format: 'date-time' } },
        { type: 'object', properties: { b: { type: 'string', format: 'date-time' } } },
      ],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-additional-members-types.ts', 'allof-additional-members-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-additional-members-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated allOf additionalProperties member models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec<Record<string, unknown>>(generatedCodecIdFromRoot(output, 'Visit'));
  const wire = { members: { x: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } };
  const model = codec.fromWireFormat(wire, { construct: VisitModel as unknown as abstract new (values?: never) => object });
  assert.deepEqual(model.members, { x: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') });
  assert.deepEqual(codec.toWireFormat(model), wire);
});

test(`an allOf of object members that share a property name converts it once (validation false)`, async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-allof-same-name-members-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    members: {
      allOf: [
        { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } },
        { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } },
      ],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-same-name-members-types.ts', 'allof-same-name-members-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-same-name-members-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated allOf additionalProperties member models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec<Record<string, unknown>>(generatedCodecIdFromRoot(output, 'Visit'));
  const wire = { members: { at: '2024-05-06T07:08:09.000Z' } };
  const model = codec.fromWireFormat(wire, { construct: VisitModel as unknown as abstract new (values?: never) => object });
  assert.deepEqual(model.members, { at: new Date('2024-05-06T07:08:09.000Z') });
  assert.deepEqual(codec.toWireFormat(model), wire);
});

for (const validation of [true, false]) test(`an array whose items are an allOf of object members converts every item (validation ${validation})`, async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-allof-object-items-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    entries: {
      type: 'array',
      items: {
        allOf: [
          { type: 'object', properties: { a: { type: 'string', format: 'date-time' } } },
          { type: 'object', properties: { b: { type: 'string', format: 'date-time' } } },
        ],
      },
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-object-items-types.ts', 'allof-object-items-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-object-items-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated allOf object items models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec<{ entries: unknown }>(generatedCodecIdFromRoot(output, 'Visit'));
  const wire = { entries: [{ a: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' }, { a: '2024-05-08T09:10:11.000Z' }] };
  const model = codec.fromWireFormat(wire, { construct: VisitModel as unknown as abstract new (values?: never) => object });
  assert.deepEqual(model.entries, [
    { a: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') },
    { a: new Date('2024-05-08T09:10:11.000Z') },
  ]);
  assert.deepEqual(codec.toWireFormat(model), wire);
});

test('an object field with own additionalProperties and an allOf member that adds properties accepts its input with validation on', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-own-additional-members-'), 'sdk');
  await generateMaterializedSdk(sequenceSerdeDocument({
    members: {
      type: 'object',
      additionalProperties: { type: 'string', format: 'date-time' },
      allOf: [{ type: 'object', properties: { b: { type: 'string', format: 'date-time' } } }],
    },
  }), {
    output,
    name: 'SequenceSerde',
    profile: { mobx: false, validation: true, allowAny: false },
  });
  copyFixtureFile(output, 'openapi/model-serde/allof-own-additional-types.ts', 'allof-own-additional-types.ts');
  compileGeneratedSdk(output, [path.join(output, 'allof-own-additional-types.ts')], { strict: true, skipLibCheck: true });

  const models = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href),
    'generated own additionalProperties and allOf member models',
  );
  const VisitModel = models.VisitModel as unknown as new (values?: Record<string, unknown>) => Record<string, unknown>;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Visit'));
  const construct = VisitModel as unknown as abstract new (values?: never) => object;

  assert.doesNotThrow(() => codec.fromWireFormat({ members: { b: '2024-05-07T08:09:10.000Z' } }, { construct }));
  assert.doesNotThrow(() => codec.fromWireFormat({ members: { x: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } }, { construct }));
});
