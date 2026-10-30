import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { registerIModelClass } from '@exprtlabs/golem/internal/model-runtime';
import type { Validator } from '@exprtlabs/golem/validation';
import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { code, type StringifySerdeResolver, identifier } from '@exprtlabs/golem/internal/emitter';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';

import { instantiateRuntime, type RuntimeFunction, emitCodecRuntimeText } from './emitted-runtime.js';
import { compileValidationPlanBinding, type FastCheck } from './support/compiled-validators.js';
import { DATE_FIELD, DATE_SERDE } from './support/date-field.js';

// The generated codec of one model `Order`, run on its compiled validators. The scope the codec runs in is the test's:
// each validator and fast check in it records the plane it checks, which shows the route a value took (spec 7.1).

const RULES_MODULE = [
  'export const positive = value => { globalThis.positiveCalls = (globalThis.positiveCalls ?? 0) + 1; return typeof value === "number" && value > 0; };',
  'export const explode = () => { throw globalThis.ruleError; };',
  'export const count = () => 3;',
].join('\n');

/** What a check judges: the model, its wire form, or what is left to check after the other form's check (`#model-only`, `#wire-only`). */
type Plane = 'model' | 'wire' | 'model-only' | 'wire-only' | 'item';

/** The model class of the IModel `Item`, which the codec constructs and the validators select. */
class ItemModel {
  public constructor(values: object = {}) {
    Object.assign(this, values);
  }
}

/** A class value: the model holds the instance, the wire holds its text. */
class Bytes {
  public constructor(public readonly text: string) {}
}

const BYTES_SERDE: StringifySerdeResolver = {
  deserialize: (id, value) => id === 'bytes' ? code`new Bytes(${value} as string)` : id === 'date' ? DATE_SERDE.deserialize(id, value) : code`Number(${value})`,
  serialize: (id, value) => id === 'bytes' ? code`(${value} as Bytes).text` : id === 'date' ? DATE_SERDE.serialize(id, value) : code`String(${value})`,
};

interface Routes {
  readonly validator: Plane[];
  readonly fast: Plane[];
}

interface Codec {
  readonly functions: Record<string, RuntimeFunction>;
  /** The planes of the full validators and of the fast checks called since the last `take`. */
  readonly calls: Routes;
  readonly binding: Awaited<ReturnType<typeof compileValidationPlanBinding>>;
  readonly codecId: string;
}

/** The routes taken since the last call. */
function take(calls: Routes): Routes {
  const taken = { validator: [...calls.validator], fast: [...calls.fast] };
  calls.validator.length = 0;
  calls.fast.length = 0;
  return taken;
}

/** `nested` adds the IModel `Item`, which a field of the order refers to as a constructed class. */
async function orderCodec(descriptor: ModelTypeDescriptor, fastPath: boolean, nested = false): Promise<Codec> {
  const graph = createSchemaGraph();
  const item = nested ? graph.intern(ITEM, 'Item', true) : undefined;
  const root = graph.intern(descriptor, 'Order');
  graph.seal();
  if (item !== undefined) registerIModelClass(item.codecId, ItemModel);
  const plan = buildCodecValidationPlan([graph], [], {}, true);
  const binding = await compileValidationPlanBinding(plan, {
    fastPath,
    validations: Object.fromEntries(['positive', 'explode', 'count'].map(name => [name, { importPath: './rules.mjs', exportName: name }])),
    modules: { 'rules.mjs': RULES_MODULE },
  });
  const planes: [string, Plane][] = [[root.codecId, 'model'], [`${root.codecId}#wire`, 'wire'], [`${root.codecId}#model-only`, 'model-only'], [`${root.codecId}#wire-only`, 'wire-only']];
  const planeOf = new Map<string, Plane>();
  for (const [id, plane] of planes) {
    if (!Object.hasOwn(plan.schemas, id)) continue;
    planeOf.set(binding.validatorName(id), plane);
    const fast = binding.fastCheckName(id);
    if (fast !== undefined) planeOf.set(fast, plane);
  }
  const calls: Routes = { validator: [], fast: [] };
  const countValidator = (name: string, run: Validator): Validator => (value, all) => {
    calls.validator.push(planeOf.get(name) ?? 'item');
    return run(value, all);
  };
  const countFast = (name: string, run: FastCheck): FastCheck => value => {
    calls.fast.push(planeOf.get(name) ?? 'item');
    return run(value);
  };
  const scope = {
    Bytes,
    ...Object.fromEntries(Object.entries(binding.scope).map(([name, run]) => [name, countValidator(name, run)])),
    ...Object.fromEntries(Object.entries(binding.fastScope).map(([name, run]) => [name, countFast(name, run)])),
    ...Object.fromEntries(Object.entries(binding.passScope).map(([name, run]) => [name, (value: unknown, all: boolean) => {
      passRuns.push(name);
      return run(value, all);
    }])),
  };
  const source = emitCodecRuntimeText(graph, { validatorName: (id) => identifier(binding.validatorName(id)), fastCheckName: (id) => { const name = binding.fastCheckName(id); return name === undefined ? undefined : identifier(name); }, passCheckNames: (id) => { const names = binding.passCheckNames(id); return names === undefined ? undefined : { structure: identifier(names.structure), predicates: identifier(names.predicates) }; }, serde: BYTES_SERDE });
  return { functions: instantiateRuntime(source, scope), calls, binding, codecId: root.codecId };
}

/** The structure checks and predicates-only passes that ran, by export name, since a test cleared it. */
const passRuns: string[] = [];

const order = (properties: Record<string, ModelTypeDescriptor>, required: readonly string[]): ModelTypeDescriptor => ({
  kind: 'object', properties, required, additionalProperties: false,
});

const hidden = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const result = { ...value };
  Object.defineProperty(result, key, { value: result[key], enumerable: false });
  return result;
};

const LINE = order({ sku: { kind: 'string' }, qty: { kind: 'number' } }, ['sku', 'qty']);
const ITEM = order({ sku: { kind: 'string' } }, ['sku']);
const ITEM_FIELD: ModelTypeDescriptor = { kind: 'reference', name: 'Item', construct: true };
/** A class value that only its TSerde codec converts: the model schema accepts any value, the wire schema wants text. */
const BYTES: ModelTypeDescriptor = { kind: 'class-value', typeName: 'Bytes', serde: { id: 'bytes', wire: { kind: 'string' } } };
/** A number the wire holds as at most four digits of text: each plane keeps a rule that the other plane cannot check. */
const STOCK: ModelTypeDescriptor = {
  kind: 'number',
  constraints: [{ kind: 'minimum', value: 0 }],
  serde: { id: 'stock', wire: { kind: 'string', constraints: [{ kind: 'pattern', value: '^-?[0-9]+$' }, { kind: 'maxLength', value: 4 }] } },
};

const ID_ONLY = order({ id: { kind: 'string' } }, ['id']);
const WITH_DATE = order({ id: { kind: 'string' }, at: DATE_FIELD }, ['id', 'at']);
const WITH_STOCK = order({ id: { kind: 'string' }, stock: STOCK }, ['id', 'stock']);
const WITH_ITEM = order({ id: { kind: 'string' }, item: ITEM_FIELD }, ['id', 'item']);
const WITH_BYTES = order({ id: { kind: 'string' }, blob: BYTES }, ['id', 'blob']);

/** A model value that the codec accepts, with an invalid one, and whether the model refers to the IModel `Item`. */
const FIXTURES: readonly (readonly [name: string, descriptor: ModelTypeDescriptor, valid: unknown, invalid: unknown, nested?: true])[] = [
  ['a Date field', WITH_DATE, { id: 'a', at: new Date(0) }, { id: 'a', at: 'not a Date' }],
  ['an undefined-valued optional field', order({ id: { kind: 'string' }, note: { kind: 'string' } }, ['id']), { id: 'a', note: undefined }, { id: 'a', note: 1 }],
  ['a non-enumerable field', ID_ONLY, hidden({ id: 'a', extra: 1 }, 'extra'), hidden({ id: 'a' }, 'id')],
  ['an array of nested objects', order({ lines: { kind: 'array', item: LINE } }, ['lines']), { lines: [{ sku: 'a', qty: 1 }] }, { lines: [{ sku: 'a' }] }],
  ['an IModel instance', WITH_ITEM, { id: 'a', item: new ItemModel({ sku: 's' }) }, { id: 'a', item: new ItemModel() }, true],
  ['a class value', WITH_BYTES, { id: 'a', blob: new Bytes('AQID') }, { id: 'a' }],
];

for (const [name, descriptor, valid, invalid, nested] of FIXTURES) {
  test(`generated codec, ${name}: a valid value takes the fast route, an invalid one the validator's`, async () => {
    const { functions, calls } = await orderCodec(descriptor, true, nested);
    assert.equal(functions.validateOrder(valid), true);
    assert.equal(functions.assertOrder(valid), valid);
    assert.deepEqual(take(calls), { validator: [], fast: ['model', 'model'] });
    assert.equal(functions.validateOrder(invalid), false);
    assert.throws(() => functions.assertOrder(invalid), LibError);
    assert.deepEqual(take(calls), { validator: ['model', 'model'], fast: ['model', 'model'] });
  });
}

/** The planes each public conversion checks on a valid value; none of them reaches the full validator. */
interface ConversionRoutes {
  readonly toWireFormat: readonly Plane[];
  readonly fromWireFormat: readonly Plane[];
  readonly parse: readonly Plane[];
  readonly stringify: readonly Plane[];
}

const CONVERSIONS: readonly {
  readonly name: string;
  readonly descriptor: ModelTypeDescriptor;
  readonly model: unknown;
  readonly wire: unknown;
  readonly nested?: true;
  readonly fast: ConversionRoutes;
}[] = [
  {
    name: 'a model whose wire is its model',
    descriptor: LINE,
    model: { sku: 'a', qty: 1 },
    wire: { sku: 'a', qty: 1 },
    fast: { toWireFormat: ['model'], fromWireFormat: ['model'], parse: ['model'], stringify: ['model'] },
  },
  {
    name: 'a Date field',
    descriptor: WITH_DATE,
    model: { id: 'a', at: new Date(0) },
    wire: { id: 'a', at: '1970-01-01T00:00:00.000Z' },
    fast: { toWireFormat: ['model', 'wire-only'], fromWireFormat: ['wire', 'model-only'], parse: ['wire', 'model-only'], stringify: ['model', 'wire-only'] },
  },
  {
    name: 'a TSerde number with a rule on each plane',
    descriptor: WITH_STOCK,
    model: { id: 'a', stock: 5 },
    wire: { id: 'a', stock: '5' },
    fast: { toWireFormat: ['model', 'wire-only'], fromWireFormat: ['wire', 'model-only'], parse: ['wire', 'model-only'], stringify: ['model', 'wire-only'] },
  },
  {
    name: 'an IModel instance',
    descriptor: WITH_ITEM,
    model: { id: 'a', item: new ItemModel({ sku: 's' }) },
    wire: { id: 'a', item: { sku: 's' } },
    nested: true,
    fast: { toWireFormat: ['model'], fromWireFormat: ['model'], parse: ['model'], stringify: ['model'] },
  },
  {
    name: 'a class value',
    descriptor: WITH_BYTES,
    model: { id: 'a', blob: new Bytes('AQID') },
    wire: { id: 'a', blob: 'AQID' },
    fast: { toWireFormat: ['model', 'wire-only'], fromWireFormat: ['wire', 'model-only'], parse: ['wire', 'model-only'], stringify: ['model', 'wire-only'] },
  },
];

for (const { name, descriptor, model, wire, nested, fast } of CONVERSIONS) {
  test(`generated codec, ${name}: every conversion of a valid value runs fast checks only`, async () => {
    const { functions, calls } = await orderCodec(descriptor, true, nested);
    const conversions: readonly (readonly [keyof ConversionRoutes, () => unknown, unknown])[] = [
      ['toWireFormat', () => functions.toWireFormatOrder(model), wire],
      ['fromWireFormat', () => functions.fromWireFormatOrder(wire), model],
      ['parse', () => functions.parseOrder(JSON.stringify(wire)), model],
      ['stringify', () => functions.stringifyOrder(model), JSON.stringify(wire)],
    ];
    const taken = conversions.map(([conversion, run, expected]) => {
      assert.deepEqual(run(), expected, conversion);
      return [conversion, take(calls)] as const;
    });
    assert.deepEqual(
      { validator: taken.flatMap(([, routes]) => routes.validator), fast: Object.fromEntries(taken.map(([conversion, routes]) => [conversion, routes.fast])) },
      { validator: [], fast },
    );
  });
}

/** One invalid value for each plane that the public conversions check, with the validator that must then run. */
const PLANE_FAILURES: readonly (readonly [plane: Plane, run: (functions: Record<string, RuntimeFunction>) => unknown, fast: readonly Plane[]])[] = [
  ['model', functions => functions.toWireFormatOrder({ id: 5, stock: 1 }), ['model']],
  ['wire', functions => functions.fromWireFormatOrder({ id: 'a', stock: 5 }), ['wire']],
  ['model-only', functions => functions.fromWireFormatOrder({ id: 'a', stock: '-5' }), ['wire', 'model-only']],
  ['wire-only', functions => functions.toWireFormatOrder({ id: 'a', stock: 12345 }), ['model', 'wire-only']],
];

for (const [plane, run, fast] of PLANE_FAILURES) {
  test(`generated codec: an invalid value of the ${plane} plane fails its fast check and takes that plane's validator`, async () => {
    const { functions, calls } = await orderCodec(WITH_STOCK, true);
    assert.throws(() => run(functions), LibError);
    assert.deepEqual(take(calls), { validator: [plane], fast });
  });
}

// No silent decline: each of these model roots gets a fast check, and it gives its validator's verdict on a valid and an invalid value.
const FAST_ROOTS: readonly (readonly [feature: string, descriptor: ModelTypeDescriptor, valid: unknown, invalid: unknown, nested?: true])[] = [
  ...FIXTURES,
  ['scalars', order({ id: { kind: 'string' }, n: { kind: 'number' }, ok: { kind: 'boolean' } }, ['id', 'n', 'ok']), { id: 'a', n: 1, ok: true }, { id: 'a', n: '1', ok: true }],
  ['a literal and a nullable string', order({ kind: { kind: 'literal', value: 'open' }, note: { kind: 'union', variants: [{ kind: 'string' }, { kind: 'null' }] } }, ['kind', 'note']), { kind: 'open', note: null }, { kind: 'closed', note: null }],
  [
    'string and number limits (K5, K6)',
    order({
      code: { kind: 'string', constraints: [{ kind: 'minLength', value: 2 }, { kind: 'pattern', value: '^a' }] },
      amount: { kind: 'number', constraints: [{ kind: 'minimum', value: 0 }, { kind: 'multipleOf', value: 5 }] },
    }, ['code', 'amount']),
    { code: 'ab', amount: 10 },
    { code: 'ab', amount: 7 },
  ],
  ['a tuple (K7)', order({ pair: { kind: 'tuple', items: [{ kind: 'string' }, { kind: 'number' }] } }, ['pair']), { pair: ['a', 1] }, { pair: ['a', 'b'] }],
  [
    'an array with limits and unique items (K7, K8)',
    order({ tags: { kind: 'array', item: { kind: 'string' }, constraints: [{ kind: 'minItems', value: 1 }, { kind: 'uniqueItems' }] } }, ['tags']),
    { tags: ['a', 'b'] },
    { tags: ['a', 'a'] },
  ],
  [
    'a record of numbers (K13)',
    order({ bag: { kind: 'object', properties: {}, required: [], additionalProperties: { kind: 'number' } } }, ['bag']),
    { bag: { a: 1 } },
    { bag: { a: 'x' } },
  ],
  [
    'a tagged union (K21)',
    order({
      pet: {
        kind: 'union',
        variants: [
          order({ kind: { kind: 'literal', value: 'cat' }, lives: { kind: 'number' } }, ['kind', 'lives']),
          order({ kind: { kind: 'literal', value: 'dog' }, barks: { kind: 'boolean' } }, ['kind', 'barks']),
        ],
        discriminator: { propertyName: 'kind', variants: [{ values: ['cat'] }, { values: ['dog'] }] },
      },
    }, ['pet']),
    { pet: { kind: 'dog', barks: true } },
    { pet: { kind: 'dog' } },
  ],
  ['an untagged union (K22)', order({ v: { kind: 'union', variants: [{ kind: 'string' }, { kind: 'number' }] } }, ['v']), { v: 1 }, { v: true }],
  ['a never field (K30)', order({ id: { kind: 'string' }, gone: { kind: 'never' } }, ['id']), { id: 'a' }, { id: 'a', gone: 1 }],
];

for (const [feature, descriptor, valid, invalid, nested] of FAST_ROOTS) {
  test(`the model root of ${feature} has a fast check that agrees with its validator`, async () => {
    const { binding, codecId } = await orderCodec(descriptor, true, nested);
    const name = binding.fastCheckName(codecId);
    assert.notEqual(name, undefined, 'the root has a fast check');
    const isValid = binding.fastScope[name ?? ''];
    const validate = binding.scope[binding.validatorName(codecId)];
    assert.deepEqual(
      { fast: [isValid(valid), isValid(invalid)], full: [validate(valid, true).length === 0, validate(invalid, true).length === 0] },
      { fast: [true, false], full: [true, false] },
    );
  });
}

// The same table for the planes of one model: each has a fast check that agrees with its validator.
const PLANE_ROOTS: readonly (readonly [plane: Plane, suffix: string, valid: unknown, invalid: unknown])[] = [
  ['model', '', { id: 'a', stock: 1 }, { id: 'a', stock: -1 }],
  ['wire', '#wire', { id: 'a', stock: '1' }, { id: 'a', stock: 1 }],
  ['model-only', '#model-only', { id: 'a', stock: 1 }, { id: 'a', stock: -1 }],
  ['wire-only', '#wire-only', { id: 'a', stock: '1' }, { id: 'a', stock: '12345' }],
];

for (const [plane, suffix, valid, invalid] of PLANE_ROOTS) {
  test(`the ${plane} root of a TSerde model has a fast check that agrees with its validator`, async () => {
    const { binding, codecId } = await orderCodec(WITH_STOCK, true);
    const name = binding.fastCheckName(`${codecId}${suffix}`);
    assert.notEqual(name, undefined, 'the root has a fast check');
    const isValid = binding.fastScope[name ?? ''];
    const validate = binding.scope[binding.validatorName(`${codecId}${suffix}`)];
    assert.deepEqual(
      { fast: [isValid(valid), isValid(invalid)], full: [validate(valid, true).length === 0, validate(invalid, true).length === 0] },
      { fast: [true, false], full: [true, false] },
    );
  });
}

test('generated codec with a TValidation predicate checks the structure, then runs the predicate once, with no full validator', async () => {
  // protects: T-469 valid and predicate-failing values never reach the full validator
  const { functions, calls, binding, codecId } = await orderCodec(order({ amount: { kind: 'number', validations: ['positive'] } }, ['amount']), true);
  assert.equal(binding.fastCheckName(codecId), undefined, 'a root that reaches a predicate has no fast check');
  assert.notEqual(binding.passCheckNames(codecId), undefined, 'a root that reaches a predicate conjunctively has a structure check');
  Reflect.set(globalThis, 'positiveCalls', 0);
  assert.equal(functions.validateOrder({ amount: 5 }), true);
  assert.throws(() => functions.assertOrder({ amount: -1 }), LibError);
  assert.deepEqual({ ...take(calls), predicate: Reflect.get(globalThis, 'positiveCalls') }, { validator: [], fast: [], predicate: 2 });
});

// A model with a converter (the Date), so decode and parse check the model-only plane; two fields beside the predicate to fail the structure.
const GUARDED = order({ amount: { kind: 'number', validations: ['positive'] }, name: { kind: 'string' }, at: DATE_FIELD }, ['amount', 'name']);
const AT = new Date(0);
const AT_WIRE = '1970-01-01T00:00:00.000Z';

/** Each public site of a codec, the value it takes and what it does with a value that fails. */
const SITES: readonly (readonly [site: string, run: (functions: Record<string, RuntimeFunction>, input: Record<string, unknown>) => unknown, form: 'model' | 'wire'])[] = [
  ['toWireFormat', (functions, input) => functions.toWireFormatOrder(input), 'model'],
  ['stringify', (functions, input) => functions.stringifyOrder(input), 'model'],
  ['validate', (functions, input) => functions.validateOrder(input), 'model'],
  ['assertValue', (functions, input) => functions.assertOrder(input), 'model'],
  ['fromWireFormat', (functions, input) => functions.fromWireFormatOrder(input), 'wire'],
  ['parse', (functions, input) => functions.parseOrder(JSON.stringify(input)), 'wire'],
];

/** The predicate calls of one site on `values`, and whether it reported a failure (a thrown LibError, or `false` from validate). */
function predicateRun(run: () => unknown): { readonly predicate: number; readonly failed: boolean } {
  Reflect.set(globalThis, 'positiveCalls', 0);
  let failed = false;
  try {
    failed = run() === false;
  } catch (error) {
    if (!(error instanceof LibError)) throw error;
    failed = true;
  }
  return { predicate: Number(Reflect.get(globalThis, 'positiveCalls')), failed };
}

for (const [site, run, form] of SITES) {
  test(`${site} of a model with a predicate runs the predicate once on a valid value and once on a failing predicate`, async () => {
    // protects: T-469 each predicate runs exactly once at each validated site
    const { functions } = await orderCodec(GUARDED, true);
    const input = (amount: number): Record<string, unknown> => ({ amount, name: 'a', at: form === 'model' ? AT : AT_WIRE });
    assert.deepEqual(
      { valid: predicateRun(() => run(functions, input(5))), predicateFails: predicateRun(() => run(functions, input(-1))) },
      { valid: { predicate: 1, failed: false }, predicateFails: { predicate: 1, failed: true } },
    );
  });
}

/** What a site throws for a value whose predicate cannot finish. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

for (const [site, run] of SITES) {
  test(`${site} wraps a TValidation function that throws in a LibError of its own`, async () => {
    // protects: T-550 a throwing predicate gives LibError Validation with causedByInput false and the original as cause
    const original = new Error('rule broke');
    Reflect.set(globalThis, 'ruleError', original);
    const { functions } = await orderCodec(order({ amount: { kind: 'number', validations: ['explode'] } }, ['amount']), true);
    const error = thrownBy(() => run(functions, { amount: 5 }));
    assert.ok(error instanceof LibError);
    assert.deepEqual({ kind: error.kind, message: error.message, causedByInput: error.causedByInput, issues: error.issues }, {
      kind: 'validation', message: 'Model validation could not finish.', causedByInput: false, issues: [],
    });
    assert.equal(error.cause, original);
  });
}

test('a TValidation function that returns a number makes parse throw a LibError that holds the TypeError', async () => {
  // protects: T-550 a predicate result that is neither boolean nor string is wrapped too
  const { functions } = await orderCodec(order({ amount: { kind: 'number', validations: ['count'] } }, ['amount']), true);
  const error = thrownBy(() => functions.parseOrder('{"amount":5}'));
  assert.ok(error instanceof LibError);
  assert.deepEqual({ kind: error.kind, message: error.message, causedByInput: error.causedByInput }, {
    kind: 'validation', message: 'Model validation could not finish.', causedByInput: false,
  });
  assert.deepEqual({ name: (error.cause as Error).name, message: (error.cause as Error).message }, { name: 'TypeError', message: 'Validation function count must return boolean or string.' });
});

test('a LibError that a TValidation function throws passes through validate unchanged', async () => {
  // protects: T-550 the wrap keeps a LibError the application threw
  const original = new LibError(LibErrorKind.Validation, 'stop here');
  Reflect.set(globalThis, 'ruleError', original);
  const { functions } = await orderCodec(order({ amount: { kind: 'number', validations: ['explode'] } }, ['amount']), true);
  assert.equal(thrownBy(() => functions.assertOrder({ amount: 5 })), original);
});

test('a validation context decides: neither the structure check nor the predicates-only pass runs, and no predicate', async () => {
  // protects: T-469 a validation context keeps its own validator
  const { functions } = await orderCodec(GUARDED, true);
  const asked: string[] = [];
  const validationContext = { resolve: (reference: string) => { asked.push(reference); return () => []; } };
  passRuns.length = 0;
  Reflect.set(globalThis, 'positiveCalls', 0);
  const results = [
    functions.validateOrder({ amount: -1, name: 'a' }, { validationContext }),
    functions.assertOrder({ amount: -1, name: 1 }, { validationContext }) !== undefined,
  ];
  assert.deepEqual({ results, passRuns, predicate: Reflect.get(globalThis, 'positiveCalls'), asked: asked.length > 0 }, { results: [true, true], passRuns: [], predicate: 0, asked: true });
});

for (const [site, run, form] of SITES) {
  test(`${site} of a model whose structure fails runs the full validator, and each predicate at most once`, async () => {
    // protects: T-469 a structure failure runs the full validator, no predicate before it
    const { functions } = await orderCodec(GUARDED, true);
    const bad = { amount: 5, name: 1, at: form === 'model' ? AT : AT_WIRE };
    const { predicate, failed } = predicateRun(() => run(functions, bad));
    assert.ok(predicate <= 1, `the predicate ran ${predicate} times`);
    assert.equal(failed, true);
  });
}

// Golden: a failing value gives the same error, issues and messages with the fast check as without it.
const FAILING: readonly (readonly [descriptor: ModelTypeDescriptor, value: unknown, nested?: true])[] = [
  ...FIXTURES.map(([, descriptor, , invalid, nested]) => [descriptor, invalid, nested] as const),
  [order({ id: { kind: 'string' }, at: DATE_FIELD }, ['id', 'at']), { at: 'x', extra: true }],
  [order({ lines: { kind: 'array', item: LINE } }, ['lines']), { lines: [{ qty: 'one' }, 5] }],
  [order({ amount: { kind: 'number', validations: ['positive'] } }, ['amount']), { amount: -1 }],
  [GUARDED, { amount: -1, name: 'a' }],
  [GUARDED, { amount: 5, name: 1 }],
  [GUARDED, { amount: -1, name: 1, at: 'x' }],
];

/** The error `run` throws as data. Any error that is not a LibError is a fault of the test, so it ends the test. */
function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (!(error instanceof LibError)) throw error;
    return { message: error.message, kind: error.kind, issues: error.issues };
  }
  return 'no error';
}

test('failing values report the same error, issues and messages with the fast check as without it', async () => {
  const outcomes = async (fastPath: boolean): Promise<readonly unknown[]> => Promise.all(FAILING.map(async ([descriptor, value, nested]) => {
    const { functions } = await orderCodec(descriptor, fastPath, nested);
    return [failure(() => functions.assertOrder(value)), failure(() => functions.assertOrder(value, { failFast: false })), failure(() => functions.fromWireFormatOrder(value, { validate: true }))];
  }));
  const [fast, full] = await Promise.all([outcomes(true), outcomes(false)]);
  assert.deepEqual(fast, full);
  assert.ok(full.flat().every(entry => entry !== 'no error'), 'every value fails');
});
