import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import {
  captureRequest,
  compileGeneratedSdk,
  generateMaterializedSdk,
  importGeneratedModule,
  importSdkCodecs,
  isGeneratedClientClass,
  requireRecord,
  sdkFunction,
  type CapturedRequest,
} from './helpers.js';

const PROFILE = { mobx: false, validation: true, allowAny: false } as const;

function document(event: Record<string, unknown>): unknown {
  return {
    openapi: '3.1.0',
    info: { title: 'Events', version: '1.0.0' },
    paths: {},
    components: { schemas: { Event: { type: 'object', additionalProperties: false, ...event } } },
  };
}

const EVENT = document({
  required: ['at', 'day', 'span', 'clock', 'maybe'],
  properties: {
    at: { type: 'string', format: 'date-time' },
    day: { type: 'string', format: 'date' },
    span: { type: 'string', format: 'duration' },
    clock: { type: 'string', format: 'time' },
    maybe: { type: ['string', 'null'], format: 'date-time' },
  },
});

const EVENT_REFERENCE = { $ref: '#/components/schemas/Event' };

/** The Event document with `createEvent`, which takes and returns an Event, and `listEvents`, which returns no body. */
const EVENT_OPERATIONS = {
  ...(EVENT as Record<string, unknown>),
  paths: {
    '/events': {
      post: {
        operationId: 'createEvent',
        requestBody: { required: true, content: { 'application/json': { schema: EVENT_REFERENCE } } },
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: EVENT_REFERENCE } } } },
      },
      get: { operationId: 'listEvents', responses: { 204: { description: 'None' } } },
    },
  },
};

test('dates: temporal maps date-time, date and duration to Temporal and keeps time a string', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-temporal-dates-'), 'sdk');
  await generateMaterializedSdk(EVENT, { output, name: 'Events', profile: PROFILE, dates: 'temporal' });
  compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
  const models = await importSdkCodecs(output, 'generated codecs');
  const wire = { at: '2025-01-02T03:04:05Z', day: '2025-01-02', span: 'P1D', clock: '03:04:05Z', maybe: null };
  const model = sdkFunction<Record<string, unknown>>(models, 'fromWireFormat', 'Event')(wire);
  assert.ok(model.at instanceof Temporal.Instant);
  assert.ok(model.day instanceof Temporal.PlainDate);
  assert.ok(model.span instanceof Temporal.Duration);
  assert.equal(model.clock, '03:04:05Z');
  assert.equal(model.maybe, null);
  assert.deepEqual(sdkFunction(models, 'toWireFormat', 'Event')(model), wire);
});

test('dates: temporal models encode to the ISO strings the generated client sends and validates', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-temporal-request-'), 'sdk');
  await generateMaterializedSdk(EVENT_OPERATIONS, { output, name: 'Events', profile: PROFILE, dates: 'temporal' });
  compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
  const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
  const codecs = await importSdkCodecs(output, 'generated codecs');
  assert.ok(isGeneratedClientClass(models.EventsClient), 'generated client');
  const wire = { at: '2025-01-02T03:04:05Z', day: '2025-01-02', span: 'P1D', clock: '03:04:05Z', maybe: null };
  const requests: CapturedRequest[] = [];
  const client = new models.EventsClient({
    baseUrl: 'https://api.test',
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(captureRequest(url, init));
      return Response.json(wire, { status: 201 });
    },
  });
  const model = sdkFunction<Record<string, unknown>>(codecs, 'fromWireFormat', 'Event')(wire);
  assert.ok(model.at instanceof Temporal.Instant);
  const response = await client.createEvent().execute({ body: sdkFunction(codecs, 'toWireFormat', 'Event')(model) as never });
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), wire);
});

test('a standalone SDK writes its sdkCodecs table, keyed by operation, and loading the index loads it', async t => {
  // protects: T-707 the shared module writes the sdkCodecs table the client reads
  const output = path.join(createFixtureProject(t, 'golem-openapi-sdk-codecs-'), 'sdk');
  await generateMaterializedSdk(EVENT_OPERATIONS, { output, name: 'Events', profile: PROFILE, dates: 'temporal' });
  compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
  const { sdkCodecs } = requireRecord(await importGeneratedModule(output, 'sdk codecs', 'dist/codecs.generated.js'), 'sdk codecs module') as { sdkCodecs: Record<string, Record<string, unknown>> };
  assert.deepEqual(Object.keys(sdkCodecs).sort(), ['createEvent', 'listEvents']);
  assert.deepEqual(Object.keys(sdkCodecs.createEvent ?? {}), ['input', 'responses', 'encode', 'decode']);
  assert.deepEqual(Object.keys(sdkCodecs.listEvents ?? {}), ['input']);
  const wire = { at: '2025-01-02T03:04:05Z', day: '2025-01-02', span: 'P1D', clock: '03:04:05Z', maybe: null };
  const decoded = (sdkCodecs.createEvent?.decode as (wire: unknown) => Record<string, unknown>)(wire);
  assert.ok(decoded.at instanceof Temporal.Instant);
  assert.deepEqual((sdkCodecs.createEvent?.encode as (value: unknown) => unknown)(decoded), wire);
  assert.match(fs.readFileSync(path.join(output, 'index.ts'), 'utf8'), /^import '\.\/codecs\.generated\.js';$/m);
});

test('dates omitted and dates: date generate the same SDK, with Date values', async t => {
  const root = createFixtureProject(t, 'golem-openapi-temporal-default-');
  const omitted = await generateMaterializedSdk(EVENT, { output: path.join(root, 'omitted', 'sdk'), name: 'Events', profile: PROFILE });
  const explicit = await generateMaterializedSdk(EVENT, { output: path.join(root, 'explicit', 'sdk'), name: 'Events', profile: PROFILE, dates: 'date' });
  const contents = (result: typeof omitted) => result.artifacts.map(artifact => [path.basename(artifact.path), artifact.content]).sort();
  assert.deepEqual(contents(explicit), contents(omitted));
  assert.match(contents(omitted).map(([, content]) => content).join('\n'), /\bat: Date\b/);
});

test('a component named Date or Temporal does not capture the converted date types', async t => {
  // protects: T-689 the converted types name the global Date and Temporal, not a component of the same name
  const root = createFixtureProject(t, 'golem-openapi-temporal-shadow-');
  const shadowed = document({ required: ['at', 'day'], properties: { at: { type: 'string', format: 'date-time' }, day: { type: 'string', format: 'date' } } }) as { components: { schemas: Record<string, unknown> } };
  shadowed.components.schemas.Date = { type: 'object', properties: { year: { type: 'integer' } } };
  shadowed.components.schemas.Temporal = { type: 'object', properties: { zone: { type: 'string' } } };
  for (const dates of ['date', 'temporal'] as const) {
    const output = path.join(root, dates, 'sdk');
    await generateMaterializedSdk(shadowed, { output, name: 'Events', profile: PROFILE, dates });
    compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
    const types = fs.readFileSync(path.join(output, 'types.ts'), 'utf8');
    assert.match(types, dates === 'date' ? /at: globalThis\.Date;/ : /at: globalThis\.Temporal\.Instant;/);
  }
});

test('dates: temporal rejects a date-time union with another string branch', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-temporal-union-'), 'sdk');
  const ambiguous = document({
    required: ['when'],
    properties: { when: { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'string' }] } },
  });
  await assert.rejects(
    generateMaterializedSdk(ambiguous, { output, name: 'Events', profile: PROFILE, dates: 'temporal' }),
    /one Temporal branch and optional null/,
  );
});

test('dates: temporal rejects a date-time union with another string branch inside an inline allOf of an operation, and dates: date names Date', async t => {
  // protects: round-2 finding 5: the inline schema check of an operation ran with dates: date whatever the option was
  const inline = {
    openapi: '3.1.0',
    info: { title: 'Events', version: '1.0.0' },
    paths: {
      '/events': {
        get: {
          operationId: 'getEvent',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { allOf: [{ type: 'object', required: ['when'], properties: { when: { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'string' }] } } }] } } },
            },
          },
        },
      },
    },
  };
  const root = createFixtureProject(t, 'golem-openapi-temporal-inline-');
  await assert.rejects(
    generateMaterializedSdk(inline, { output: path.join(root, 'temporal', 'sdk'), name: 'Events', profile: PROFILE, dates: 'temporal' }),
    /one Temporal branch and optional null/,
  );
  await assert.rejects(
    generateMaterializedSdk(inline, { output: path.join(root, 'date', 'sdk'), name: 'Events', profile: PROFILE, dates: 'date' }),
    /cannot be converted to Date/,
  );
});

test('dates: temporal rejects a date-time union with another string branch inside a component allOf, and dates: date names Date', async t => {
  // protects: T-586 the allOf check of a component read dates: date whatever the option was
  const component = {
    openapi: '3.1.0',
    info: { title: 'Events', version: '1.0.0' },
    paths: {},
    components: { schemas: { Event: { allOf: [{ type: 'object', required: ['when'], properties: { when: { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'string' }] } } }] } } },
  };
  const root = createFixtureProject(t, 'golem-openapi-temporal-component-');
  await assert.rejects(
    generateMaterializedSdk(component, { output: path.join(root, 'temporal', 'sdk'), name: 'Events', profile: PROFILE, dates: 'temporal' }),
    /one Temporal branch and optional null/,
  );
  await assert.rejects(
    generateMaterializedSdk(component, { output: path.join(root, 'date', 'sdk'), name: 'Events', profile: PROFILE, dates: 'date' }),
    /cannot be converted to Date/,
  );
});

const TEMPORAL_LIB = { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] };

async function generateTemporalModels(t: Parameters<typeof createFixtureProject>[0], prefix: string, doc: unknown): Promise<Record<string, unknown>> {
  const output = path.join(createFixtureProject(t, prefix), 'sdk');
  await generateMaterializedSdk(doc, { output, name: 'Events', profile: PROFILE, dates: 'temporal' });
  compileGeneratedSdk(output, [], TEMPORAL_LIB);
  return importSdkCodecs(output, 'generated codecs');
}

test('dates: temporal converts array items, nullable items and nested arrays', async t => {
  const models = await generateTemporalModels(t, 'golem-openapi-temporal-arrays-', document({
    required: ['instants', 'days', 'spans', 'grid'],
    properties: {
      instants: { type: 'array', items: { type: 'string', format: 'date-time' } },
      days: { type: 'array', items: { type: ['string', 'null'], format: 'date' } },
      spans: { type: 'array', items: { type: 'string', format: 'duration' } },
      grid: { type: 'array', items: { type: 'array', items: { type: 'string', format: 'date-time' } } },
    },
  }));
  const wire = { instants: ['2025-01-02T03:04:05Z'], days: ['2025-01-02', null], spans: ['P1D', 'PT1H'], grid: [['2025-01-02T03:04:05Z'], []] };
  const model = sdkFunction<Record<string, unknown[]>>(models, 'fromWireFormat', 'Event')(wire);
  assert.ok(model.instants![0] instanceof Temporal.Instant);
  assert.ok(model.days![0] instanceof Temporal.PlainDate);
  assert.equal(model.days![1], null);
  assert.ok(model.spans!.every(item => item instanceof Temporal.Duration));
  assert.ok((model.grid![0] as unknown[])[0] instanceof Temporal.Instant);
  assert.deepEqual(sdkFunction(models, 'toWireFormat', 'Event')(model), wire);
});

test('dates: temporal converts fields of models that reference each other across groups', async t => {
  const models = await generateTemporalModels(t, 'golem-openapi-temporal-groups-', {
    openapi: '3.1.0',
    info: { title: 'Events', version: '1.0.0' },
    paths: {},
    components: { schemas: {
      Venue: { type: 'object', additionalProperties: false, required: ['opens', 'closes'], properties: {
        opens: { type: 'string', format: 'date' },
        closes: { type: 'array', items: { type: 'string', format: 'date-time' } },
      } },
      Event: { type: 'object', additionalProperties: false, required: ['at', 'venue'], properties: {
        at: { type: 'string', format: 'date-time' },
        venue: { $ref: '#/components/schemas/Venue' },
      } },
      Booking: { type: 'object', additionalProperties: false, required: ['events', 'span'], properties: {
        events: { type: 'array', items: { $ref: '#/components/schemas/Event' } },
        span: { type: 'string', format: 'duration' },
      } },
    } },
  });
  const wire = { events: [{ at: '2025-01-02T03:04:05Z', venue: { opens: '2025-01-02', closes: ['2025-01-02T10:00:00Z'] } }], span: 'P1D' };
  const model = sdkFunction<{ events: { at: unknown; venue: { opens: unknown; closes: unknown[] } }[]; span: unknown }>(models, 'fromWireFormat', 'Booking')(wire);
  assert.ok(model.events[0]!.at instanceof Temporal.Instant);
  assert.ok(model.events[0]!.venue.opens instanceof Temporal.PlainDate);
  assert.ok(model.events[0]!.venue.closes[0] instanceof Temporal.Instant);
  assert.ok(model.span instanceof Temporal.Duration);
  assert.deepEqual(sdkFunction(models, 'toWireFormat', 'Booking')(model), wire);
});
