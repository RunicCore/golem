import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject, compileModelProject } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tsSource } from './source-template.js';
import { generate } from '#model/generator';

async function build(t: TestContext) {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-temporal-tags-', name: 'temporal-tags', ttscPlugin: true, linkWorkspaceNodeModules: true,
    compilerOptions: { lib: ['ES2023', 'DOM', 'esnext.temporal'] },
  });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A',
    imports: tsSource`import type { TemporalDuration, TemporalInstant, TemporalPlainDate, TemporalPlainDateTime, TemporalPlainTime, TemporalZonedDateTime } from '@exprtlabs/golem/temporal';`,
    fields: tsSource`at: TemporalInstant; zoned: TemporalZonedDateTime; day: TemporalPlainDate; local: TemporalPlainDateTime; time: TemporalPlainTime; span: TemporalDuration; maybe: TemporalInstant | null`,
  }).text);
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  return import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js'))) as Promise<{
    parseA: (text: string) => Record<string, unknown>;
    stringifyA: (value: object) => string;
  }>;
}

const WIRE = {
  at: '2025-01-02T03:04:05.123Z',
  zoned: '2025-01-02T03:04:05+01:00[Europe/Paris]',
  day: '2025-01-02',
  local: '2025-01-02T03:04:05',
  time: '03:04:05.123',
  span: 'P1DT2H',
  maybe: null,
};

test('nanosecond precision survives a round trip', async t => {
  const codecs = await build(t);
  const wire = { ...WIRE, at: '2025-01-02T03:04:05.123456789Z', time: '03:04:05.123456789' };
  assert.deepEqual(JSON.parse(codecs.stringifyA(codecs.parseA(JSON.stringify(wire)))), wire);
});

test('Temporal tags round-trip through parse and stringify', async t => {
  const codecs = await build(t);
  const model = codecs.parseA(JSON.stringify(WIRE));
  assert.ok(model.at instanceof Temporal.Instant);
  assert.ok(model.zoned instanceof Temporal.ZonedDateTime);
  assert.ok(model.day instanceof Temporal.PlainDate);
  assert.ok(model.local instanceof Temporal.PlainDateTime);
  assert.ok(model.time instanceof Temporal.PlainTime);
  assert.ok(model.span instanceof Temporal.Duration);
  assert.deepEqual(JSON.parse(codecs.stringifyA(model)), WIRE);
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
  test(`Temporal tag ${field} rejects ${bad}`, async t => {
    const codecs = await build(t);
    assert.throws(() => codecs.parseA(JSON.stringify({ ...WIRE, [field]: bad })));
  });
}

test('a missing Temporal gives the load-a-polyfill error', async () => {
  const { deserializeTemporalInstant } = await import('@exprtlabs/golem/temporal');
  const saved = globalThis.Temporal;
  Reflect.deleteProperty(globalThis, 'Temporal');
  try {
    assert.throws(() => deserializeTemporalInstant('2025-01-02T03:04:05Z' as never), /Temporal is not available; load a polyfill such as `temporal-polyfill\/global` before converting/);
  } finally {
    Object.assign(globalThis, { Temporal: saved });
  }
});
