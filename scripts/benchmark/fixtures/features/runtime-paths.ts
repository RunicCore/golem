import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { registerIModelClass, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { codecIdOf } from './codec-id.js';
import type { ComparisonFixture } from './fixture-contract.js';
import { TemporalFields, TreeNode, UniqueLists } from './runtime-paths.model.js';

for (const [name, model] of [['TTemporalFields', TemporalFields], ['TTreeNode', TreeNode], ['TUniqueLists', UniqueLists]] as const) {
  registerIModelClass(codecIdOf(name), model);
}

export type RuntimePathName = 'temporal' | 'recursive' | 'unique-items';

const TREE_BREADTH = [5, 4, 4] as const;
const UNIQUE_NAMES = 1000;
const UNIQUE_POINTS = 100;

interface TreeWire { label: string; children: TreeWire[] }

/** The wire value of the temporal payload. Every string is the form its Temporal class writes, so a round trip returns the same text. */
function temporalWire() {
  return {
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T03:04:05Z', expiresAt: '2026-02-01T10:00:00.25Z', shippedAt: '2026-03-31T23:59:59Z',
    opensAt: '2026-01-01T12:00:00+01:00[Europe/Paris]', closesAt: '2026-02-01T08:30:00-05:00[America/New_York]', nextRun: '2026-03-01T00:00:00+00:00[UTC]',
    birthday: '1990-05-17', startDate: '2026-01-01', endDate: '2026-12-31', dueDate: '2026-06-30',
    scheduled: '2026-01-01T09:00:00', reviewed: '2026-02-15T14:30:00', archived: '2026-03-31T23:59:59.5',
    doorOpens: '08:00:00', doorCloses: '18:30:00', lunch: '12:15:00',
    setup: 'PT1H30M', runtime: 'P1DT2H', cooldown: 'PT0.5S',
  };
}

/** A tree three levels below the root (5, 4 and 4 children), 106 nodes in all. */
function treeWire(): TreeWire {
  let count = 0;
  const node = (level: number): TreeWire => ({ label: `node ${count++}`, children: Array.from({ length: TREE_BREADTH[level] ?? 0 }, () => node(level + 1)) });
  return node(0);
}

const nodesOf = (tree: { children: unknown[] }): number => 1 + (tree.children as { children: unknown[] }[]).reduce((sum, child) => sum + nodesOf(child), 0);

/** Distinct strings, and distinct objects that share their keys, so a `jsonEqual` walk compares object with object. */
function uniqueWire() {
  return {
    names: Array.from({ length: UNIQUE_NAMES }, (_, index) => `name ${index}`),
    points: Array.from({ length: UNIQUE_POINTS }, (_, index) => ({ x: index, y: index * 2, label: `point ${index}` })),
  };
}

function consume(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.length;
  return 1;
}

const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;
const libError = (error: unknown): boolean => error instanceof LibError;

interface RuntimePath {
  readonly name: RuntimePathName;
  readonly codecName: string;
  readonly construct: new (values?: never) => object;
  readonly wire: unknown;
  /** The model that a decode of `wire` must give. */
  readonly checkModel: (model: unknown) => void;
  /** A copy of `wire` that a validating build must reject, and the check that its error is the expected kind. */
  readonly broken: () => unknown;
  readonly isRejection: (error: unknown) => boolean;
}

const paths: readonly RuntimePath[] = [
  {
    name: 'temporal', codecName: 'TTemporalFields', construct: TemporalFields, wire: temporalWire(),
    checkModel: model => {
      const fields = model as Record<string, unknown>;
      const classes = { createdAt: Temporal.Instant, opensAt: Temporal.ZonedDateTime, birthday: Temporal.PlainDate, scheduled: Temporal.PlainDateTime, doorOpens: Temporal.PlainTime, setup: Temporal.Duration };
      for (const [field, Class] of Object.entries(classes)) assert.ok(fields[field] instanceof Class, field);
      assert.equal(Object.keys(fields).length, 20);
    },
    // An unreadable instant is a conversion error, not a validation issue, so the check accepts any golem error.
    broken: () => ({ ...temporalWire(), createdAt: 'yesterday' }), isRejection: libError,
  },
  {
    name: 'recursive', codecName: 'TTreeNode', construct: TreeNode, wire: treeWire(),
    checkModel: model => assert.equal(nodesOf(model as { children: unknown[] }), 106),
    broken: () => { const tree = treeWire(); tree.children[0]!.children[0]!.children[0]!.label = 5 as never; return tree; }, isRejection: validationError,
  },
  {
    name: 'unique-items', codecName: 'TUniqueLists', construct: UniqueLists, wire: uniqueWire(),
    checkModel: model => {
      const lists = model as ReturnType<typeof uniqueWire>;
      assert.equal(lists.names.length, UNIQUE_NAMES);
      assert.equal(lists.points.length, UNIQUE_POINTS);
    },
    broken: () => { const lists = uniqueWire(); lists.points[UNIQUE_POINTS - 1] = { ...lists.points[0]! }; return lists; }, isRejection: validationError,
  },
];

/**
 * The payloads of the golem cost table that time a runtime path no other payload reaches: Temporal conversion (`temporal`, on the polyfill
 * `temporal-polyfill`), a recursive model (`recursive`) and the `UniqueItems` check of a string list and an object list (`unique-items`).
 * Each is timed on the IModel adapters only. The verify step proves a round trip back to the same JSON and, in a validating build,
 * that a broken value is rejected.
 */
export function createRuntimePathFixtures(validation: boolean): readonly ComparisonFixture[] {
  return paths.map(({ name, codecName, construct, wire: payload, checkModel, broken, isRejection }) => {
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
        for (const decoded of [codec.fromWireFormat(payload, decodeOptions), codec.parse(text, decodeOptions)]) {
          assert.ok(decoded instanceof construct);
          checkModel(decoded);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(codec.toWireFormat(model as never, encodeOptions))), original);
        assert.equal(codec.stringify(model as never, encodeOptions), text, 'JSON output is the same compact wire representation');
        assert.deepEqual(payload, original);
        if (!validation) return;
        assert.equal(codec.validate(model as never), true);
        assert.throws(() => codec.fromWireFormat(broken(), decodeOptions), isRejection);
        assert.throws(() => codec.parse(JSON.stringify(broken()), decodeOptions), isRejection);
      },
    } satisfies ComparisonFixture;
  });
}
