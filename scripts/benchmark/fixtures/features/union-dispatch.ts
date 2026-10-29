import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { registerIModelClass, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { codecIdOf } from './codec-id.js';
import type { ComparisonFixture } from './fixture-contract.js';
import { ClassCircle, ClassEvents, ClassLine, ClassRect, ClassText, TaggedEvents } from './union-dispatch.model.js';

for (const [name, model] of [['TClassCircle', ClassCircle], ['TClassRect', ClassRect], ['TClassLine', ClassLine], ['TClassText', ClassText], ['TClassEvents', ClassEvents], ['TTaggedEvents', TaggedEvents]] as const) {
  registerIModelClass(codecIdOf(name), model);
}

export type UnionDispatchName = 'union-tagged' | 'union-class';
const EVENTS = 100;

const stamp = (index: number): string => new Date(Date.UTC(2026, 0, 1 + index)).toISOString();

/** One wire value for both payloads: a hundred events that cycle through the four shapes. Each holds one date, so every event converts one value in both models. */
function wire() {
  return {
    events: Array.from({ length: EVENTS }, (_, index) => {
      switch (index % 4) {
        case 0: return { kind: 'circle' as const, radius: index, label: `circle ${index}`, at: stamp(index) };
        case 1: return { kind: 'rect' as const, width: index, height: index + 1, label: `rect ${index}`, at: stamp(index) };
        case 2: return { kind: 'line' as const, length: index, label: `line ${index}`, at: stamp(index) };
        default: return { kind: 'text' as const, text: `text ${index}`, size: index, at: stamp(index) };
      }
    }),
  };
}

function consume(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.length;
  const events = (value as { events?: unknown } | null)?.events;
  return Array.isArray(events) ? events.length : 1;
}

const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;
const isPlain = (value: unknown): boolean => typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The tagged-union pair of the golem cost table (E-42): the same wire value and text, as a union of inline objects (`union-tagged`: the
 * encoder dispatches on the tag) and as a union of generated model classes (`union-class`: it dispatches on the instance's class first).
 * The verify step proves the model holds plain objects in the first and the variant classes in the second.
 */
export function createUnionDispatchFixtures(validation: boolean): readonly ComparisonFixture[] {
  return ([['union-tagged', 'TTaggedEvents', TaggedEvents], ['union-class', 'TClassEvents', ClassEvents]] as const).map(([name, codecName, construct]) => {
    const payload = wire();
    const text = JSON.stringify(payload);
    const codec = requireObjectCodec(codecIdOf(codecName));
    const decodeOptions = { ...(validation ? {} : { validate: false as const }), construct };
    const encodeOptions = validation ? {} : { validate: false as const };
    const model = codec.fromWireFormat(payload, decodeOptions);
    return {
      name, payload, consume,
      operations: {
        'object-to-model': () => codec.fromWireFormat(payload, decodeOptions),
        'model-to-object': () => codec.toWireFormat(model as never, encodeOptions),
        'text-to-model': () => codec.parse(text, decodeOptions),
        'model-to-text': () => codec.stringify(model as never, encodeOptions),
        ...(validation ? { validate: () => { if (!codec.validate(model as never)) throw new Error('Class validate rejected a valid fixture'); return true; } } : {}),
      },
      verify: async () => {
        const original = structuredClone(payload);
        for (const decoded of [codec.fromWireFormat(payload, decodeOptions), codec.parse(text, decodeOptions)] as { events: unknown[] }[]) {
          assert.ok(decoded instanceof construct);
          assert.equal(decoded.events.length, EVENTS);
          const classes = [ClassCircle, ClassRect, ClassLine, ClassText];
          decoded.events.forEach((event, index) => {
            if (name === 'union-class') assert.ok(event instanceof classes[index % 4]); else assert.ok(isPlain(event));
            assert.ok((event as { at: unknown }).at instanceof Date);
          });
        }
        assert.deepEqual(JSON.parse(JSON.stringify(codec.toWireFormat(model as never, encodeOptions))), original);
        assert.equal(codec.stringify(model as never, encodeOptions), text, 'JSON output is the same compact wire representation');
        assert.deepEqual(payload, original);
        if (!validation) return;
        assert.equal(codec.validate(model as never), true);
        const broken = { events: [{ kind: 'triangle', label: 'x' }] };
        assert.throws(() => codec.fromWireFormat(broken, decodeOptions), validationError);
        assert.throws(() => codec.parse(JSON.stringify(broken), decodeOptions), validationError);
      },
    } satisfies ComparisonFixture;
  });
}
