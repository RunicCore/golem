import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LibError } from '@exprtlabs/golem/errors';
import { createModelProject, buildModelProject, writeModelGolemYaml } from './model-project.js';
import { fileFixtureScope, onceShared, type FixtureScope } from './fixture-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tsSource } from './source-template.js';

/** Builds the model `A` of `source` in a project named `name`, with the user's files in `files`, and returns its generated codecs. */
async function buildCodecs(scope: FixtureScope, name: string, source: Parameters<typeof taggedModelSource>[0], files: Readonly<Record<string, string>> = {}) {
  const { root, sourceRoot } = createModelProject(scope, {
    prefix: `golem-${name}-`, name, linkWorkspaceNodeModules: true,
    compilerOptions: { lib: ['ES2023', 'DOM', 'esnext.temporal'] },
  });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(sourceRoot, file), text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource(source).text);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  return import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js'))) as Promise<{
    parseTA: (text: string) => Record<string, unknown>;
    stringifyTA: (value: object) => string;
    fromWireFormatTA: (wire: unknown, options?: { validate?: boolean }) => Record<string, unknown>;
  }>;
}

/** A rejection of bad input: a `LibError` that names the input as its cause. */
const isInputError = (error: unknown): boolean => error instanceof LibError && error.causedByInput === true;

// Every test reads the same model, so the file builds it once.
const fileScope = fileFixtureScope();
const build = onceShared(() => buildCodecs(fileScope, 'temporal-tags', { name: 'A',
  imports: tsSource`import type { TemporalDuration, TemporalInstant, TemporalPlainDate, TemporalPlainDateTime, TemporalPlainTime, TemporalZonedDateTime } from '@exprtlabs/golem/temporal';`,
  fields: tsSource`at: TemporalInstant; zoned: TemporalZonedDateTime; day: TemporalPlainDate; local: TemporalPlainDateTime; time: TemporalPlainTime; span: TemporalDuration; maybe: TemporalInstant | null`,
}));

const WIRE = {
  at: '2025-01-02T03:04:05.123Z',
  zoned: '2025-01-02T03:04:05+01:00[Europe/Paris]',
  day: '2025-01-02',
  local: '2025-01-02T03:04:05',
  time: '03:04:05.123',
  span: 'P1DT2H',
  maybe: null,
};

test('nanosecond precision survives a round trip', async () => {
  const codecs = await build();
  const wire = { ...WIRE, at: '2025-01-02T03:04:05.123456789Z', time: '03:04:05.123456789' };
  assert.deepEqual(JSON.parse(codecs.stringifyTA(codecs.parseTA(JSON.stringify(wire)))), wire);
});

test('Temporal tags round-trip through parse and stringify', async () => {
  const codecs = await build();
  const model = codecs.parseTA(JSON.stringify(WIRE));
  assert.ok(model.at instanceof Temporal.Instant);
  assert.ok(model.zoned instanceof Temporal.ZonedDateTime);
  assert.ok(model.day instanceof Temporal.PlainDate);
  assert.ok(model.local instanceof Temporal.PlainDateTime);
  assert.ok(model.time instanceof Temporal.PlainTime);
  assert.ok(model.span instanceof Temporal.Duration);
  assert.deepEqual(JSON.parse(codecs.stringifyTA(model)), WIRE);
});

for (const [field, bad] of [
  ['at', '2025-01-02'],
  ['zoned', '2025-01-02T03:04:05+01:00'],
  ['zoned', '2025-01-02T03:04:05+01:00[Europe/Paris][u-ca=japanese]'],
  ['day', '2025-01-02T00:00:00Z'],
  ['local', '2025-01-02T03:04:05Z'],
  ['time', '03:04:05+01:00'],
  ['span', '1 day'],
] as const) {
  test(`Temporal tag ${field} rejects ${bad}`, async () => {
    const codecs = await build();
    assert.throws(() => codecs.parseTA(JSON.stringify({ ...WIRE, [field]: bad })), isInputError);
  });
}

test('a missing Temporal gives the load-a-polyfill error', async () => {
  const { deserializeTemporalInstant } = await import('@exprtlabs/golem/temporal');
  const saved = globalThis.Temporal;
  Reflect.deleteProperty(globalThis, 'Temporal');
  try {
    assert.throws(() => deserializeTemporalInstant('2025-01-02T03:04:05Z' as never), (error: unknown) => error instanceof LibError && /Temporal is not available; load a polyfill such as `temporal-polyfill\/global` before converting/.test(error.message));
  } finally {
    Object.assign(globalThis, { Temporal: saved });
  }
});

// Canonical Temporal strings the wire check must accept: fractional, negative and mixed-week durations, and an offset zone.
for (const [field, value] of [
  ['span', 'PT0.000000001S'],
  ['span', '-P1D'],
  ['span', 'P1W1D'],
  ['zoned', '2025-01-02T03:04:05+01:00[+01:00]'],
] as const) {
  test(`Temporal tag ${field} round-trips ${value}`, async () => {
    const codecs = await build();
    const wire = { ...WIRE, [field]: value };
    assert.deepEqual(JSON.parse(codecs.stringifyTA(codecs.parseTA(JSON.stringify(wire)))), wire);
  });
}

// The same six classes written as plain global types: the built-in class registry gives them the conversion and the wire rule of the tags above.
const PLAIN_FIELDS = tsSource`at: Temporal.Instant; zoned: Temporal.ZonedDateTime; day: Temporal.PlainDate; local: Temporal.PlainDateTime; time: Temporal.PlainTime; span: Temporal.Duration`;

const EPOCH_CODEC = `export function encodeEpoch(value: Temporal.Instant): number { return value.epochMilliseconds; }
export function decodeEpoch(value: number): Temporal.Instant { return Temporal.Instant.fromEpochMilliseconds(value); }
`;

const buildPlain = onceShared(() => buildCodecs(fileScope, 'temporal-plain', { name: 'A',
  imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import { decodeEpoch, encodeEpoch } from './codec.js';`,
  fields: tsSource`${PLAIN_FIELDS}; epoch: Temporal.Instant & TSerde<typeof encodeEpoch, typeof decodeEpoch>`,
}, { 'codec.ts': EPOCH_CODEC }));
const PLAIN_WIRE = { at: WIRE.at, zoned: WIRE.zoned, day: WIRE.day, local: WIRE.local, time: WIRE.time, span: WIRE.span, epoch: 1735787045123 };

test('each plain global Temporal class round-trips', async () => {
  // protects: R-89 a built-in Temporal class converts with no tag, to the same wire text as the tag
  const codecs = await buildPlain();
  const model = codecs.parseTA(JSON.stringify(PLAIN_WIRE));
  const classes = { at: Temporal.Instant, zoned: Temporal.ZonedDateTime, day: Temporal.PlainDate, local: Temporal.PlainDateTime, time: Temporal.PlainTime, span: Temporal.Duration };
  for (const [field, Class] of Object.entries(classes)) assert.ok(model[field] instanceof Class, field);
  assert.deepEqual(JSON.parse(codecs.stringifyTA(model)), PLAIN_WIRE);
});

test('a user TSerde over a Temporal class wins over the built-in class', async () => {
  // protects: R-89 a user X & TSerde keeps its own wire form over the registry entry
  const codecs = await buildPlain();
  const model = codecs.parseTA(JSON.stringify(PLAIN_WIRE));
  assert.ok(model.epoch instanceof Temporal.Instant);
  assert.equal(JSON.parse(codecs.stringifyTA(model)).epoch, 1735787045123);
  assert.throws(() => codecs.parseTA(JSON.stringify({ ...PLAIN_WIRE, epoch: '2025-01-02T03:04:05Z' })), isInputError);
});

for (const [field, bad] of [
  ['at', '2025-01-02'],
  ['zoned', '2025-01-02T03:04:05+01:00'],
  ['day', '2025-01-02T00:00:00Z'],
  ['local', '2025-01-02T03:04:05Z'],
  ['time', '03:04:05+01:00'],
  ['span', '1 day'],
] as const) {
  test(`a plain Temporal field ${field} rejects ${bad}`, async () => {
    // protects: R-89 a plain Temporal field rejects text outside its wire form
    const codecs = await buildPlain();
    assert.throws(() => codecs.parseTA(JSON.stringify({ ...PLAIN_WIRE, [field]: bad })), isInputError);
  });
}
