import { copyFixtureFile, createFixtureProject, type FixtureScope } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { LibError, LibErrorKind, IssueRepresentation, IssueSource } from '@exprtlabs/golem/errors';
import {
  clientBodyCodec,
  compileGeneratedSdk,
  compileStrictUnusedSdk,
  documentBase,
  generateMaterializedSdk,
  loadGeneratedClient,
  requireRecord,
  sdkBodyCodec,
  withRootOperations,
  type SdkBodyCodec,
} from './helpers.js';
import { loadGolemModeProject, type GolemModeProject, type GolemModeSdkSetup } from './sdk-client-fixture.js';

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

function tupleSerdeDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'TupleSerde', version: '1' },
    paths: {},
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

/** The Visit document whose fields are `properties`; `schemas` adds the components that those fields reference. */
function sequenceSerdeDocument(
  properties: Record<string, unknown>,
  schemas: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'SequenceSerde', version: '1' },
    paths: {},
    components: {
      schemas: {
        Visit: {
          type: 'object',
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
        },
        ...schemas,
      },
    },
  };
}

/** Generates the SDK of a document (with a body operation for its Visit schema) into a fresh project and returns its output folder. */
async function generateSerdeSdk(t: FixtureScope, prefix: string, document: Record<string, unknown>, { validation }: { readonly validation: boolean }): Promise<string> {
  const output = path.join(createFixtureProject(t, prefix), 'sdk');
  await generateMaterializedSdk(withRootOperations(document, 'Visit'), {
    output,
    name: 'SequenceSerde',
    profile: { validation, allowAny: false },
  });
  return output;
}

/** Compiles the SDK with the fixture file `openapi/model-serde/<name>.ts`, which checks the generated types. */
function compileSerdeTypes(output: string, name: string): void {
  copyFixtureFile(output, `openapi/model-serde/${name}.ts`, `${name}.ts`);
  compileGeneratedSdk(output, [path.join(output, `${name}.ts`)], { strict: true, skipLibCheck: true });
}

/** The Visit body of the SDK in `output` through its client: `decode` gives the body as a record. */
async function generateVisitBody(output: string): Promise<{ decode(wire: unknown): Promise<Record<string, unknown>>; encode(value: unknown): Promise<unknown> }> {
  const codec = await sdkBodyCodec(output, 'SequenceSerde', 'Visit');
  return {
    decode: async wire => requireRecord(await codec.decode(wire), 'Visit'),
    encode: value => codec.encode(value),
  };
}

/** The predicate of `assert.rejects` for a failed validation. */
function assertValidationError(error: unknown): true {
  assert.ok(error instanceof LibError);
  assert.equal(error.kind, LibErrorKind.Validation);
  return true;
}

const isLibError = (error: unknown): boolean => error instanceof LibError;

/** A body as it is on the wire and as the client gives it; the client converts its dates by the schema. */
interface ConversionRow { readonly wire: unknown; readonly value: unknown }

const DERIVED_EVENT: ConversionRow = {
  wire: { baseWhen: '2025-02-03T04:05:06.000Z', baseLabel: 'base', derivedWhen: '2025-03-04T05:06:07.000Z' },
  value: { baseWhen: new Date('2025-02-03T04:05:06.000Z'), baseLabel: 'base', derivedWhen: new Date('2025-03-04T05:06:07.000Z') },
};
const DICTIONARY: ConversionRow = {
  wire: { first: { when: '2025-04-05T06:07:08.000Z', child: { id: 'dictionary-child' } } },
  value: { first: { when: new Date('2025-04-05T06:07:08.000Z'), child: { id: 'dictionary-child' } } },
};
const DERIVED_DICTIONARY: ConversionRow = {
  wire: {
    baseWhen: '2025-06-07T08:09:10.000Z',
    derivedWhen: '2025-07-08T09:10:11.000Z',
    entry: { when: '2025-08-09T10:11:12.000Z', child: { id: 'derived-dictionary-child' } },
  },
  value: {
    baseWhen: new Date('2025-06-07T08:09:10.000Z'),
    derivedWhen: new Date('2025-07-08T09:10:11.000Z'),
    entry: { when: new Date('2025-08-09T10:11:12.000Z'), child: { id: 'derived-dictionary-child' } },
  },
};
const ITINERARY: ConversionRow = {
  wire: { stops: ['label', '2024-05-06T07:08:09.000Z'], leg: ['gate', '2024-05-07T08:09:10.000Z'], held: ['2024-05-08T09:10:11.000Z'] },
  value: { stops: ['label', new Date('2024-05-06T07:08:09.000Z')], leg: ['gate', new Date('2024-05-07T08:09:10.000Z')], held: [new Date('2024-05-08T09:10:11.000Z')] },
};

async function assertConverts(codec: SdkBodyCodec, row: ConversionRow): Promise<void> {
  assert.deepEqual(await codec.decode(row.wire), row.value);
  assert.deepEqual(await codec.encode(row.value), row.wire);
}

/** The body of the schema `root` of a golem-mode SDK of `project`, through its built client. */
function golemBodyCodec(project: GolemModeProject, sdk: GolemModeSdkSetup, root: string): SdkBodyCodec {
  return clientBodyCodec(fetchImpl => project.client<unknown>(sdk, { fetchImpl }), root);
}

test('nested Date, inherited, and dictionary conversions work in a standalone SDK', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-model-serde-aot-'), 'sdk');
  await generateMaterializedSdk(withRootOperations(modelSerdeDocument(), 'Event', 'DerivedEvent', 'Dictionary', 'DerivedDictionary'), {
    output,
    name: 'ModelSerde',
    profile: { validation: true, allowAny: false },
  });
  // Nested contracts: Date is the converted value, the wire contract stays a string.
  copyFixtureFile(output, "openapi/model-serde/model-serde-types.ts", "model-serde-types.ts");
  compileGeneratedSdk(output, [path.join(output, 'model-serde-types.ts')], {
    strict: true,
    skipLibCheck: true,
  });

  const event = await sdkBodyCodec(output, 'ModelSerde', 'Event');
  assert.deepEqual(await event.decode({
    when: '0099-12-31T23:59:59.9-05:00',
    maybeWhen: null,
    child: { id: 'child', when: '2025-01-02T03:04:05Z' },
    children: [{ id: 'listed' }],
    labels: ['one', 'two'],
  }), {
    when: new Date('0100-01-01T04:59:59.900Z'),
    maybeWhen: null,
    child: { id: 'child', when: new Date('2025-01-02T03:04:05Z') },
    children: [{ id: 'listed' }],
    labels: ['one', 'two'],
  });
  assert.equal(
    JSON.stringify(await event.encode({
      when: new Date('0001-01-01T00:00:00.123Z'),
      maybeWhen: null,
      child: { id: 'counted' },
      children: [{ id: 'counted' }],
      labels: ['one', 'two'],
    })),
    '{"when":"0001-01-01T00:00:00.123Z","maybeWhen":null,"child":{"id":"counted"},"children":[{"id":"counted"}],"labels":["one","two"]}',
  );
  await assert.rejects(
    () => event.decode({ when: 'not-a-date', child: { id: 'child' } }),
    (error: unknown) => {
      assert.ok(error instanceof LibError);
      assert.equal(error.kind, LibErrorKind.Validation);
      assert.equal(error.issues[0]?.source, IssueSource.OpenAPI);
      assert.equal(error.issues[0]?.representation, IssueRepresentation.Wire);
      return true;
    },
  );
  await assert.rejects(
    () => event.encode({ when: new Date('2025-01-02T03:04:05Z'), child: { id: 'invalid-child', when: new Date(Number.NaN) } }),
    (error: unknown) => {
      assert.ok(error instanceof LibError);
      assert.deepEqual(error.issues.map(issue => issue.path), [['child', 'when']]);
      return true;
    },
  );

  await assertConverts(await sdkBodyCodec(output, 'ModelSerde', 'DerivedEvent'), DERIVED_EVENT);
  await assertConverts(await sdkBodyCodec(output, 'ModelSerde', 'Dictionary'), DICTIONARY);
  await assertConverts(await sdkBodyCodec(output, 'ModelSerde', 'DerivedDictionary'), DERIVED_DICTIONARY);

  const Client = await loadGeneratedClient(output, 'ModelSerde');
  const problem = { code: 'EVENT_INVALID', message: 'event rejected by the service' };
  const client = new Client({
    baseUrl: 'https://service.example.test',
    fetchImpl: async () => new Response(JSON.stringify(problem), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  });
  assert.deepEqual(await client.createEvent!().execute({ body: { when: new Date('2025-01-02T03:04:05Z'), child: { id: 'child' } } }), {
    matched: 'status',
    status: 400,
    contentType: 'application/json',
    body: problem,
    headers: {},
  });
});

test('a tuple field converts each item by its own schema: the prefix stays a string and the rest items are Dates', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-tuple-serde-'), 'sdk');
  await generateMaterializedSdk(withRootOperations(tupleSerdeDocument(), 'Itinerary'), {
    output,
    name: 'TupleSerde',
    profile: { validation: false, allowAny: false },
  });
  compileSerdeTypes(output, 'tuple-types');

  const itinerary = await sdkBodyCodec(output, 'TupleSerde', 'Itinerary');
  await assertConverts(itinerary, ITINERARY);

  await assert.rejects(
    () => itinerary.decode({ stops: ['label', '2024-05-06T07:08:09.000Z', 'not a date'], leg: [], held: [] }),
    (error: unknown): true => {
      assert.ok(error instanceof LibError);
      assert.deepEqual(error.issues[0]?.path, ['stops', 2]);
      return true;
    },
  );
});

test('an array field with an allOf sibling converts its items to Dates and is typed Date[]', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-array-allof-', sequenceSerdeDocument({
    visits: {
      type: 'array',
      items: { type: 'string', format: 'date-time' },
      allOf: [{ minItems: 1 }],
    },
  }), { validation: false });
  compileSerdeTypes(output, 'array-types');

  const visitBody = await generateVisitBody(output);

  const visit = (await visitBody.decode({ visits: ['2024-05-06T07:08:09.000Z'] }));
  assert.deepEqual(visit.visits, [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual((await visitBody.encode(visit)), { visits: ['2024-05-06T07:08:09.000Z'] });
});

test('an SDK body with a property that has no type generates under the default allowAny and accepts any value', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-untyped-property-'), 'sdk');
  await generateMaterializedSdk(withRootOperations({
    openapi: '3.1.0',
    info: { title: 'Untyped', version: '1' },
    paths: {},
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
  }, 'Envelope'), {
    output,
    name: 'Untyped',
    profile: { validation: true, allowAny: false },
  });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });

  const envelope = await sdkBodyCodec(output, 'Untyped', 'Envelope');
  const nested = { id: 'a', payload: { nested: [1] } };
  const text = { id: 'a', payload: 'text' };
  const number = { id: 'a', payload: 7 };
  assert.deepEqual(await envelope.decode(nested), nested);
  assert.deepEqual(await envelope.decode(text), text);
  assert.deepEqual(await envelope.encode(number), number);
});

test('an array or tuple field with no type or a nullable type converts like type array, and null stays null', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-sequence-shapes-', sequenceSerdeDocument({
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
  }), { validation: false });
  compileSerdeTypes(output, 'sequence-shape-types');

  const visitBody = await generateVisitBody(output);

  const visit = (await visitBody.decode({
    maybeVisits: ['2024-05-06T07:08:09.000Z'],
    untypedVisits: ['2024-05-07T08:09:10.000Z'],
    maybeLeg: ['gate', '2024-05-08T09:10:11.000Z'],
    untypedLeg: ['door', '2024-05-09T10:11:12.000Z'],
  }));
  assert.deepEqual(visit.maybeVisits, [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(visit.untypedVisits, [new Date('2024-05-07T08:09:10.000Z')]);
  assert.deepEqual(visit.maybeLeg, ['gate', new Date('2024-05-08T09:10:11.000Z')]);
  assert.deepEqual(visit.untypedLeg, ['door', new Date('2024-05-09T10:11:12.000Z')]);
  assert.deepEqual((await visitBody.encode(visit)), {
    maybeVisits: ['2024-05-06T07:08:09.000Z'],
    untypedVisits: ['2024-05-07T08:09:10.000Z'],
    maybeLeg: ['gate', '2024-05-08T09:10:11.000Z'],
    untypedLeg: ['door', '2024-05-09T10:11:12.000Z'],
  });

  const absent = (await visitBody.decode({
    maybeVisits: null,
    untypedVisits: [],
    maybeLeg: null,
    untypedLeg: [],
  }));
  assert.equal(absent.maybeVisits, null);
  assert.equal(absent.maybeLeg, null);
});

test('allOf members decide an array field: constraint-only and restating members change nothing, a converting member wins', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-array-allof-members-', sequenceSerdeDocument({
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
  }), { validation: false });
  compileSerdeTypes(output, 'allof-sequence-types');

  const visitBody = await generateVisitBody(output);

  const visit = (await visitBody.decode({
    restatingMember: ['2024-05-06T07:08:09.000Z'],
    restatedByMember: ['2024-05-07T08:09:10.000Z'],
    membersCarry: ['2024-05-08T09:10:11.000Z'],
    describedMember: ['2024-05-09T10:11:12.000Z'],
    bareArrayMember: ['2024-05-10T11:12:13.000Z'],
    convertingMemberWins: ['2024-05-11T12:13:14.000Z'],
  }));
  assert.deepEqual(visit.restatingMember, [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(visit.restatedByMember, [new Date('2024-05-07T08:09:10.000Z')]);
  assert.deepEqual(visit.membersCarry, [new Date('2024-05-08T09:10:11.000Z')]);
  assert.deepEqual(visit.describedMember, [new Date('2024-05-09T10:11:12.000Z')]);
  assert.deepEqual(visit.bareArrayMember, [new Date('2024-05-10T11:12:13.000Z')]);
  assert.deepEqual(visit.convertingMemberWins, [new Date('2024-05-11T12:13:14.000Z')]);
});

test('a oneOf of a scalar and a nullable array or tuple converts the sequence, keeps the scalar and keeps null', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-scalar-or-nullable-sequence-', sequenceSerdeDocument({
    plainOrDates: {
      oneOf: [{ type: 'string' }, { type: ['array', 'null'], items: { type: 'string', format: 'date-time' } }],
    },
    plainOrLeg: {
      oneOf: [
        { type: 'string' },
        { type: ['array', 'null'], prefixItems: [{ type: 'string', format: 'date-time' }], items: false },
      ],
    },
  }), { validation: false });
  compileSerdeTypes(output, 'scalar-or-sequence-types');

  const visitBody = await generateVisitBody(output);

  const scalars = (await visitBody.decode({ plainOrDates: 'plain', plainOrLeg: 'plain' }));
  assert.equal(scalars.plainOrDates, 'plain');
  assert.equal(scalars.plainOrLeg, 'plain');
  const sequences = (await visitBody.decode({
    plainOrDates: ['2024-05-06T07:08:09.000Z'],
    plainOrLeg: ['2024-05-07T08:09:10.000Z'],
  }));
  assert.deepEqual(sequences.plainOrDates, [new Date('2024-05-06T07:08:09.000Z')]);
  assert.deepEqual(sequences.plainOrLeg, [new Date('2024-05-07T08:09:10.000Z')]);
  const nulls = (await visitBody.decode({ plainOrDates: null, plainOrLeg: null }));
  assert.equal(nulls.plainOrDates, null);
  assert.equal(nulls.plainOrLeg, null);
});

test('a nullable array field with an allOf minItems keeps null, rejects an empty array and accepts dates', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-nullable-array-allof-', sequenceSerdeDocument({
    visits: {
      type: ['array', 'null'],
      items: { type: 'string', format: 'date-time' },
      allOf: [{ minItems: 1 }],
    },
  }), { validation: true });
  compileSerdeTypes(output, 'nullable-array-types');

  const visitBody = await generateVisitBody(output);

  assert.equal((await visitBody.decode({ visits: null })).visits, null);
  assert.deepEqual(
    (await visitBody.decode({ visits: ['2024-05-06T07:08:09.000Z'] })).visits,
    [new Date('2024-05-06T07:08:09.000Z')],
  );
  await assert.rejects(() => visitBody.decode({ visits: [] }),
    assertValidationError,
  );
});

test('an object field whose allOf members only add constraints converts by its own properties and keeps the constraints', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-constraint-allof-object-', sequenceSerdeDocument({
    window: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ minProperties: 1 }],
    },
  }), { validation: true });
  compileSerdeTypes(output, 'allof-object-types');

  const visitBody = await generateVisitBody(output);

  const visit = (await visitBody.decode({ window: { at: '2024-05-06T07:08:09.000Z' } }));
  assert.deepEqual(visit.window, { at: new Date('2024-05-06T07:08:09.000Z') });
  await assert.rejects(() => visitBody.decode({ window: {} }),
    assertValidationError,
  );
});

test('a oneOf field whose allOf members only add constraints converts by its own oneOf', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-constraint-allof-oneof-', sequenceSerdeDocument({
    either: {
      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
      allOf: [{ description: 'when the visit happened' }],
    },
  }), { validation: false });
  compileSerdeTypes(output, 'allof-oneof-types');

  const visitBody = await generateVisitBody(output);

  assert.deepEqual(
    (await visitBody.decode({ either: '2024-05-07T08:09:10.000Z' })).either,
    new Date('2024-05-07T08:09:10.000Z'),
  );
  assert.equal((await visitBody.decode({ either: null })).either, null);
});

test('a nullable object field admits null and converts its properties', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-nullable-object-', sequenceSerdeDocument({
    window: {
      type: ['object', 'null'],
      properties: { at: { type: 'string', format: 'date-time' } },
    },
  }), { validation: true });
  compileSerdeTypes(output, 'nullable-object-types');

  const visitBody = await generateVisitBody(output);

  assert.equal((await visitBody.decode({ window: null })).window, null);
  assert.deepEqual(
    (await visitBody.decode({ window: { at: '2024-05-06T07:08:09.000Z' } })).window,
    { at: new Date('2024-05-06T07:08:09.000Z') },
  );
  await assert.doesNotReject(() => visitBody.decode({ window: null }));
});

test('a nullable object field with a constraint-only allOf admits null and still rejects an empty object', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-nullable-object-allof-', sequenceSerdeDocument({
    window: {
      type: ['object', 'null'],
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ minProperties: 1 }],
    },
  }), { validation: true });
  compileSerdeTypes(output, 'nullable-object-types');

  const visitBody = await generateVisitBody(output);

  assert.equal((await visitBody.decode({ window: null })).window, null);
  await assert.doesNotReject(() => visitBody.decode({ window: null }));
  await assert.rejects(() => visitBody.decode({ window: {} }),
    assertValidationError,
  );
});

test('a field that references a nullable component object is typed with | null and admits null', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-nullable-reference-', sequenceSerdeDocument({ pet: { $ref: '#/components/schemas/Pet' } }, {
    Pet: {
      type: ['object', 'null'],
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    },
  }), { validation: true });
  compileSerdeTypes(output, 'nullable-reference-types');

  const visitBody = await generateVisitBody(output);

  assert.equal((await visitBody.decode({ pet: null })).pet, null);
  await assert.doesNotReject(() => visitBody.decode({ pet: null }));
  assert.equal(JSON.stringify((await visitBody.decode({ pet: { name: 'Miso' } })).pet), '{"name":"Miso"}');
});

test('a field that references a nullable component with a date-time property decodes, validates and encodes it', async t => {
  // protects: T-95 nullable component with a date-time property validates its wire form
  const output = await generateSerdeSdk(t, 'golem-openapi-nullable-date-reference-', sequenceSerdeDocument({ pet: { $ref: '#/components/schemas/Pet' } }, {
    Pet: {
      type: ['object', 'null'],
      required: ['name'],
      properties: { name: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
    },
  }), { validation: true });
  compileStandaloneModelSerdeSdk(output);

  const visitBody = await generateVisitBody(output);

  const decoded = await visitBody.decode({ pet: { name: 'Miso', at: '2024-05-06T07:08:09.000Z' } });
  assert.deepEqual({ ...(decoded.pet as object) }, { name: 'Miso', at: new Date('2024-05-06T07:08:09.000Z') });
  assert.deepEqual(await visitBody.encode(decoded), { pet: { name: 'Miso', at: '2024-05-06T07:08:09.000Z' } });
  assert.equal((await visitBody.decode({ pet: null })).pet, null);
  await assert.rejects(() => visitBody.decode({ pet: { name: 'Miso', at: 'yesterday' } }),
    assertValidationError,
  );
});

for (const validation of [true, false]) test(`an object field with its own properties and an allOf member that adds properties types and converts both alike (validation ${validation})`, async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-allof-member-properties-', sequenceSerdeDocument({
    merged: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ properties: { b: { type: 'string', format: 'date-time' } } }],
    },
  }), { validation });
  compileSerdeTypes(output, 'allof-members-types');

  const visitBody = await generateVisitBody(output);

  assert.deepEqual(
    (await visitBody.decode({ merged: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } })).merged,
    { at: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') },
  );

  const wire = { merged: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } };
  const model = await visitBody.decode(wire);
  assert.deepEqual(model.merged, { at: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') });
  assert.deepEqual(await visitBody.encode(model), wire);
  const partial = [{}, { at: '2024-05-06T07:08:09.000Z' }, { b: '2024-05-07T08:09:10.000Z' }];
  for (const part of partial) {
    const partialModel = await visitBody.decode({ merged: part });
    assert.deepEqual(await visitBody.encode(partialModel), { merged: part });
  }
});

test('a name in the required list of an allOf member is required in the field type and by the validator', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-allof-required-', sequenceSerdeDocument({
    window: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ required: ['at'] }],
    },
  }), { validation: true });
  compileSerdeTypes(output, 'allof-required-types');

  const visitBody = await generateVisitBody(output);

  assert.deepEqual(
    (await visitBody.decode({ window: { at: '2024-05-06T07:08:09.000Z' } })).window,
    { at: new Date('2024-05-06T07:08:09.000Z') },
  );
  await assert.rejects(() => visitBody.decode({ window: {} }),
    assertValidationError,
  );
});

for (const validation of [true, false]) test(`an allOf of object members is typed by the same members that convert it (validation ${validation})`, async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-allof-object-members-', sequenceSerdeDocument({
    members: {
      allOf: [
        { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } },
        { type: 'object', properties: { b: { type: 'string', format: 'date-time' } } },
      ],
    },
  }), { validation });
  compileSerdeTypes(output, 'allof-object-members-types');

  const visitBody = await generateVisitBody(output);

  assert.deepEqual(
    (await visitBody.decode({ members: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } })).members,
    { at: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') },
  );

  const wire = { members: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } };
  const model = await visitBody.decode(wire);
  assert.deepEqual(model.members, { at: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') });
  assert.deepEqual(await visitBody.encode(model), wire);
  const partial = [{}, { at: '2024-05-06T07:08:09.000Z' }, { b: '2024-05-07T08:09:10.000Z' }];
  for (const part of partial) {
    const partialModel = await visitBody.decode({ members: part });
    assert.deepEqual(await visitBody.encode(partialModel), { members: part });
  }
});

test('an object field with own properties and an allOf reference to a model still generates and is typed by its own properties', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-allof-own-reference-', sequenceSerdeDocument({
    based: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ $ref: '#/components/schemas/Base' }],
    },
  }, {
    Base: { type: 'object', properties: { name: { type: 'string' } } },
  }), { validation: true });
  compileSerdeTypes(output, 'allof-own-reference-types');

  const visitBody = await generateVisitBody(output);

  await assert.doesNotReject(() => visitBody.decode({ based: { name: 'Miso' } }));
});

test('a nullable object field whose allOf member adds properties still generates', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-nullable-allof-members-', sequenceSerdeDocument({
    window: {
      type: ['object', 'null'],
      properties: { at: { type: 'string', format: 'date-time' } },
      allOf: [{ properties: { b: { type: 'string', format: 'date-time' } } }],
    },
  }), { validation: true });
  compileSerdeTypes(output, 'nullable-allof-members-types');

  const visitBody = await generateVisitBody(output);

  await assert.doesNotReject(() => visitBody.decode({ window: { b: '2024-05-07T08:09:10.000Z' } }));
});

test('a discriminated oneOf with a nullable component variant still generates and converts its variants', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-oneof-nullable-variant-', sequenceSerdeDocument({
    pet: {
      oneOf: [{ $ref: '#/components/schemas/Dog' }, { $ref: '#/components/schemas/Cat' }],
      discriminator: {
        propertyName: 'kind',
        mapping: { dog: '#/components/schemas/Dog', cat: '#/components/schemas/Cat' },
      },
    },
  }, {
    Dog: {
      type: ['object', 'null'],
      required: ['kind', 'name'],
      properties: { kind: { const: 'dog' }, name: { type: 'string' } },
    },
    Cat: {
      type: 'object',
      required: ['kind', 'name'],
      properties: { kind: { const: 'cat' }, name: { type: 'string' } },
    },
  }), { validation: true });
  compileSerdeTypes(output, 'oneof-discriminated-nullable-types');

  const visitBody = await generateVisitBody(output);

  assert.equal(JSON.stringify((await visitBody.decode({ pet: { kind: 'cat', name: 'Miso' } })).pet), '{"kind":"cat","name":"Miso"}');
  await assert.doesNotReject(() => visitBody.decode({ pet: { kind: 'dog', name: 'Rex' } }));
});

test('a oneOf variant that references a nullable component admits null and is typed with | null', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-oneof-nullable-reference-', sequenceSerdeDocument({
    either: { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'string' }] },
  }, {
    Pet: { type: ['object', 'null'], properties: { name: { type: 'string' } } },
  }), { validation: true });
  compileSerdeTypes(output, 'oneof-nullable-reference-types');

  const visitBody = await generateVisitBody(output);

  await assert.doesNotReject(() => visitBody.decode({ either: { name: 'Miso' } }));
  assert.equal((await visitBody.decode({ either: null })).either, null);
  assert.equal(((await visitBody.decode({ either: null })) as { either: unknown }).either, null);
});

for (const validation of [true, false]) for (const petType of ['object', ['object', 'null']]) {
  test(`a oneOf of a ${Array.isArray(petType) ? 'nullable ' : ''}component and a string decodes and encodes each branch by its type (validation ${validation})`, async t => {
    // protects: T-97 oneOf of a model reference and a string keeps both branches
    const output = await generateSerdeSdk(t, 'golem-openapi-oneof-reference-string-', sequenceSerdeDocument({
      either: { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'string' }] },
    }, {
      Pet: { type: petType, required: ['name'], properties: { name: { type: 'string' } } },
    }), { validation });
    compileStandaloneModelSerdeSdk(output);

    const visitBody = await generateVisitBody(output);

    const text = await visitBody.decode({ either: 'abc' });
    assert.equal(text.either, 'abc');
    assert.deepEqual(await visitBody.encode(text), { either: 'abc' });
    const pet = await visitBody.decode({ either: { name: 'Miso' } });
    assert.deepEqual(pet.either, { name: 'Miso' });
    assert.deepEqual(await visitBody.encode(pet), { either: { name: 'Miso' } });
  });
}

for (const validation of [true, false]) test(`a oneOf of a nullable component with a date-time property and a string decodes the date and admits null (validation ${validation})`, async t => {
  // protects: T-97 oneOf variant of a nullable component keeps the component's date-time conversion
  const output = await generateSerdeSdk(t, 'golem-openapi-oneof-nullable-date-', sequenceSerdeDocument({
    either: { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'string' }] },
  }, {
    Pet: {
      type: ['object', 'null'],
      required: ['name'],
      properties: { name: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
    },
  }), { validation });
  compileStandaloneModelSerdeSdk(output);

  const visitBody = await generateVisitBody(output);

  const pet = await visitBody.decode({ either: { name: 'Miso', at: '2024-05-06T07:08:09.000Z' } });
  assert.deepEqual({ ...(pet.either as object) }, { name: 'Miso', at: new Date('2024-05-06T07:08:09.000Z') });
  assert.deepEqual(await visitBody.encode(pet), { either: { name: 'Miso', at: '2024-05-06T07:08:09.000Z' } });
  assert.equal((await visitBody.decode({ either: null })).either, null);
  assert.equal((await visitBody.decode({ either: 'abc' })).either, 'abc');
});

test(`an allOf of an additionalProperties member and a properties member converts every name by the merged object (validation false)`, async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-allof-additional-members-', sequenceSerdeDocument({
    members: {
      allOf: [
        { type: 'object', additionalProperties: { type: 'string', format: 'date-time' } },
        { type: 'object', properties: { b: { type: 'string', format: 'date-time' } } },
      ],
    },
  }), { validation: false });
  compileSerdeTypes(output, 'allof-additional-members-types');

  const visitBody = await generateVisitBody(output);
  const wire = { members: { x: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } };
  const model = await visitBody.decode(wire);
  assert.deepEqual(model.members, { x: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') });
  assert.deepEqual(await visitBody.encode(model), wire);
});

test(`an allOf of object members that share a property name converts it once (validation false)`, async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-allof-same-name-members-', sequenceSerdeDocument({
    members: {
      allOf: [
        { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } },
        { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } },
      ],
    },
  }), { validation: false });
  compileSerdeTypes(output, 'allof-same-name-members-types');

  const visitBody = await generateVisitBody(output);
  const wire = { members: { at: '2024-05-06T07:08:09.000Z' } };
  const model = await visitBody.decode(wire);
  assert.deepEqual(model.members, { at: new Date('2024-05-06T07:08:09.000Z') });
  assert.deepEqual(await visitBody.encode(model), wire);
});

for (const validation of [true, false]) test(`an array whose items are an allOf of object members converts every item (validation ${validation})`, async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-allof-object-items-', sequenceSerdeDocument({
    entries: {
      type: 'array',
      items: {
        allOf: [
          { type: 'object', properties: { a: { type: 'string', format: 'date-time' } } },
          { type: 'object', properties: { b: { type: 'string', format: 'date-time' } } },
        ],
      },
    },
  }), { validation });
  compileSerdeTypes(output, 'allof-object-items-types');

  const visitBody = await generateVisitBody(output);
  const wire = { entries: [{ a: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' }, { a: '2024-05-08T09:10:11.000Z' }] };
  const model = await visitBody.decode(wire);
  assert.deepEqual(model.entries, [
    { a: new Date('2024-05-06T07:08:09.000Z'), b: new Date('2024-05-07T08:09:10.000Z') },
    { a: new Date('2024-05-08T09:10:11.000Z') },
  ]);
  assert.deepEqual(await visitBody.encode(model), wire);
});

test('an object field with own additionalProperties and an allOf member that adds properties accepts its input with validation on', async t => {
  const output = await generateSerdeSdk(t, 'golem-openapi-own-additional-members-', sequenceSerdeDocument({
    members: {
      type: 'object',
      additionalProperties: { type: 'string', format: 'date-time' },
      allOf: [{ type: 'object', properties: { b: { type: 'string', format: 'date-time' } } }],
    },
  }), { validation: true });
  compileSerdeTypes(output, 'allof-own-additional-types');

  const visitBody = await generateVisitBody(output);

  await assert.doesNotReject(() => visitBody.decode({ members: { b: '2024-05-07T08:09:10.000Z' } }));
  await assert.doesNotReject(() => visitBody.decode({ members: { x: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } }));
});

test('a body field that is only a map of dates compiles with noUnusedLocals and noUnusedParameters', async t => {
  // protects: T-498 the extra-key filter of an object with no declared field leaves no unused `key` parameter
  const output = path.join(createFixtureProject(t, 'golem-openapi-date-map-'), 'sdk');
  const dates = { type: 'object', additionalProperties: { type: 'string', format: 'date-time' } };
  await generateMaterializedSdk(withRootOperations(documentBase('3.1.0', {
    components: { schemas: { Problem: { type: 'object', required: ['field'], properties: { field: dates } } } },
  }), 'Problem'), { output, name: 'DateMap', profile: { validation: false } });
  compileStrictUnusedSdk(output);
  const problem = await sdkBodyCodec(output, 'DateMap', 'Problem');
  assert.deepEqual(await problem.decode({ field: { a: '2024-05-06T07:08:09.000Z' } }), { field: { a: new Date('2024-05-06T07:08:09.000Z') } });
});

const untaggedUnionVariants = {
  inline: [
    { type: 'object', required: ['kind', 'at'], properties: { kind: { const: 'start' }, at: { type: 'string', format: 'date-time' } } },
    { type: 'object', required: ['kind', 'at'], properties: { kind: { const: 'stop' }, at: { type: 'string', format: 'date-time' } } },
  ],
  components: [{ $ref: '#/components/schemas/Start' }, { $ref: '#/components/schemas/Stop' }],
};

for (const validation of [true, false]) for (const form of ['inline', 'components', 'inline with an unresolved discriminator keyword'] as const) {
  test(`a oneOf of ${form} objects with a required const tag and no resolved discriminator converts each variant (validation ${validation})`, async t => {
    // protects: T-594 golem-openapi-ts writes the tag table of a document union itself, so golem need not infer the tag
    const unresolved = form.startsWith('inline with');
    const output = await generateSerdeSdk(t, 'golem-openapi-oneof-untagged-', sequenceSerdeDocument({
      event: {
        oneOf: untaggedUnionVariants[form === 'components' ? 'components' : 'inline'],
        ...(unresolved ? { discriminator: { propertyName: 'kind' } } : {}),
      },
    }, form !== 'components' ? {} : {
      Start: untaggedUnionVariants.inline[0],
      Stop: untaggedUnionVariants.inline[1],
    }), { validation });
    compileStandaloneModelSerdeSdk(output);

    const visitBody = await generateVisitBody(output);

    const start = await visitBody.decode({ event: { kind: 'start', at: '2024-05-06T07:08:09.000Z' } });
    assert.deepEqual(start.event, { kind: 'start', at: new Date('2024-05-06T07:08:09.000Z') });
    assert.deepEqual(await visitBody.encode(start), { event: { kind: 'start', at: '2024-05-06T07:08:09.000Z' } });
    const stop = await visitBody.decode({ event: { kind: 'stop', at: '2024-05-07T07:08:09.000Z' } });
    assert.deepEqual(stop.event, { kind: 'stop', at: new Date('2024-05-07T07:08:09.000Z') });
    assert.deepEqual(await visitBody.encode(stop), { event: { kind: 'stop', at: '2024-05-07T07:08:09.000Z' } });
  });
}

test('a discriminator keyword that resolves to no model still tags the variants by the key it names', async t => {
  // protects: T-594 the fallback table took the first shared literal (kind) instead of the propertyName the document wrote (mode)
  const output = await generateSerdeSdk(t, 'golem-openapi-oneof-declared-key-', sequenceSerdeDocument({
    event: {
      oneOf: [
        { type: 'object', required: ['kind', 'mode', 'at'], properties: { kind: { const: 'x' }, mode: { const: 'dated' }, at: { type: 'string', format: 'date-time' } } },
        { type: 'object', required: ['kind', 'mode', 'at'], properties: { kind: { const: 'y' }, mode: { const: 'text' }, at: { type: 'string' } } },
      ],
      discriminator: { propertyName: 'mode' },
    },
  }, {}), { validation: false });
  compileStandaloneModelSerdeSdk(output);
  const visitBody = await generateVisitBody(output);
  // kind says the dated variant, mode says the text variant: the declared key decides, so `at` stays text.
  const decoded = await visitBody.decode({ event: { kind: 'x', mode: 'text', at: '2024-05-06T07:08:09.000Z' } });
  assert.equal(requireRecord(decoded.event, 'event').at, '2024-05-06T07:08:09.000Z');
});

test('the date conversions of nested, inherited, dictionary and tuple fields hold in golem-mode SDKs', async t => {
  // protects: T-696 golem mode converts through the models job's SDK node codecs, a different emitter than standalone mode
  const events: GolemModeSdkSetup = {
    document: withRootOperations(modelSerdeDocument(), 'DerivedEvent', 'Dictionary', 'DerivedDictionary'),
    folder: 'sdk/events',
    name: 'ModelSerde',
  };
  const itineraries: GolemModeSdkSetup = { document: withRootOperations(tupleSerdeDocument(), 'Itinerary'), folder: 'sdk/itineraries', name: 'TupleSerde' };
  const project = await loadGolemModeProject(t, 'model-serde-golem-', [events, itineraries], true);

  await assertConverts(golemBodyCodec(project, events, 'DerivedEvent'), DERIVED_EVENT);
  await assertConverts(golemBodyCodec(project, events, 'Dictionary'), DICTIONARY);
  await assertConverts(golemBodyCodec(project, events, 'DerivedDictionary'), DERIVED_DICTIONARY);
  await assertConverts(golemBodyCodec(project, itineraries, 'Itinerary'), ITINERARY);
  await assert.rejects(
    () => golemBodyCodec(project, itineraries, 'Itinerary').decode({ stops: ['label', '2024-05-06T07:08:09.000Z', 'not a date'], leg: [], held: [] }),
    isLibError,
  );
});
