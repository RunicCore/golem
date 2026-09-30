import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, requireRecord } from './helpers.js';

const PROFILE = { mobx: false, validation: true, ajvStandalone: false, allowAny: false } as const;

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

type EventConstructor = new (values?: object) => object;

test('dates: temporal maps date-time, date and duration to Temporal and keeps time a string', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-temporal-dates-'), 'sdk');
  await generateMaterializedSdk(EVENT, { output, name: 'Events', profile: PROFILE, dates: 'temporal' });
  compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
  const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
  const EventModel = models.EventModel as unknown as EventConstructor;
  const wire = { at: '2025-01-02T03:04:05Z', day: '2025-01-02', span: 'P1D', clock: '03:04:05Z', maybe: null };
  const model = decodeGeneratedModel(EventModel, wire) as Record<string, unknown>;
  assert.ok(model.at instanceof Temporal.Instant);
  assert.ok(model.day instanceof Temporal.PlainDate);
  assert.ok(model.span instanceof Temporal.Duration);
  assert.equal(model.clock, '03:04:05Z');
  assert.equal(model.maybe, null);
  assert.deepEqual(encodeGeneratedModel(model as never), wire);
});

test('dates omitted and dates: date generate the same SDK, with Date values', async t => {
  const root = createFixtureProject(t, 'golem-openapi-temporal-default-');
  const omitted = await generateMaterializedSdk(EVENT, { output: path.join(root, 'omitted', 'sdk'), name: 'Events', profile: PROFILE });
  const explicit = await generateMaterializedSdk(EVENT, { output: path.join(root, 'explicit', 'sdk'), name: 'Events', profile: PROFILE, dates: 'date' });
  const contents = (result: typeof omitted) => result.artifacts.map(artifact => [path.basename(artifact.path), artifact.content]).sort();
  assert.deepEqual(contents(explicit), contents(omitted));
  assert.match(contents(omitted).map(([, content]) => content).join('\n'), /\bat: Date\b/);
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
