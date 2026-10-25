import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { decodeGeneratedModel, decodeGeneratedModelTrusted } from '@exprtlabs/golem/conversion';
import { registerGeneratedModel } from '@exprtlabs/golem/model';
import { LibError, LibErrorKind, IssueSource, IssueRepresentation } from '@exprtlabs/golem/errors';
import { generate } from '#model/generator';
import { readFixture } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';

type FromWire = (wire: unknown, options?: { validate?: boolean }) => unknown;

function cycleAt(path: readonly (string | number)[]): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Deserialization);
    assert.equal(error.issues[0]?.code, 'deserialization');
    assert.equal(error.issues[0]?.source, IssueSource.Serde);
    assert.equal(error.issues[0]?.representation, IssueRepresentation.Wire);
    assert.deepEqual(error.issues[0]?.path, path);
    return true;
  };
}

class RecordModel {
  constructor(public payload: unknown) {}
}
registerGeneratedModel(RecordModel, {
  fields: ['payload'], profile: { validation: false },
  conversion: {
    decode(value) { return new RecordModel(Reflect.get(value as object, 'payload')); },
    encode(model) { return { payload: model.payload }; },
  },
});

async function loadCodecs(t: TestContext, name: string, validation = false): Promise<Record<string, FromWire>> {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-serde-isolation-',
    name: 'serde-isolation',
    linkWorkspaceNodeModules: true,
  });
  fs.writeFileSync(path.join(sourceRoot, `${name}.model.ts`), readFixture(`models/serde-isolation/${name}.model.ts`));
  writeModelGolemYaml(root, { mobx: false, validation });
  await buildModelProject(root);
  return await import(pathToFileURL(path.join(root, `build/${name}.model.generated.js`)).href) as Record<string, FromWire>;
}

test('decode rejects a cycle in a declared object or an unknown field without copying first', () => {
  const cycle: Record<string, unknown> = {};
  cycle.again = cycle;
  assert.throws(() => decodeGeneratedModel(RecordModel, { payload: [{ valid: 1 }, { last: cycle }] }), cycleAt(['payload', 1, 'last', 'again']));
});

test('decode rejects a cycle through a retained model instance', () => {
  class Holder { child: unknown; }
  registerGeneratedModel(Holder, { fields: ['child'], profile: { validation: false }, conversion: {
    decode: () => new Holder(), encode: model => ({ child: model.child }),
  } });
  const child = new Holder();
  child.child = { back: child };
  assert.throws(() => decodeGeneratedModel(Holder, { child }), cycleAt(['child', 'child', 'back']));
  child.child = { leaf: 1 };
  assert.ok(decodeGeneratedModel(Holder, { child }) instanceof Holder);
});

test('decode hands the input to the decoder uncopied', () => {
  let received: unknown;
  class Probe {}
  registerGeneratedModel(Probe, { fields: [], profile: { validation: false }, conversion: {
    decode(input) { received = input; return new Probe(); }, encode: () => ({}),
  } });
  const input = { nested: { value: 1 } };
  decodeGeneratedModel(Probe, input);
  assert.strictEqual(received, input);
  received = undefined;
  decodeGeneratedModelTrusted(Probe, input);
  assert.strictEqual(received, input);
});

test('generated decode reads each declared property once', async (t) => {
  const { fromWireFormatTPayment } = await loadCodecs(t, 'payment');
  let reads = 0;
  const wire = { id: 'p1', note: 'n', merchant: { id: 'm', name: 'M' }, billing: { name: 'B' }, money: { amount: '1.00', currency: 'USD' } };
  Object.defineProperty(wire, 'merchant', { enumerable: true, get() { reads++; return { id: 'm', name: 'M' }; } });
  fromWireFormatTPayment(wire, { validate: false });
  assert.equal(reads, 1);
});

test('generated decode with a constructor reads each declared property once and checks unknown fields', async (t) => {
  const { fromWireFormatTPayment } = await loadCodecs(t, 'payment');
  const { fromWireFormatTRecord } = await loadCodecs(t, 'recursive');
  class Construct { constructor(public fields: unknown) {} }
  let reads = 0;
  const wire = { id: 'p1', note: 'n', merchant: { id: 'm', name: 'M' }, billing: { name: 'B' }, money: { amount: '1.00', currency: 'USD' } };
  Object.defineProperty(wire, 'merchant', { enumerable: true, get() { reads++; return { id: 'm', name: 'M' }; } });
  const built = fromWireFormatTPayment(wire, { validate: false, construct: Construct } as never) as Construct;
  assert.ok(built instanceof Construct);
  assert.equal(reads, 1);
  const loop: Record<string, unknown> = {};
  loop.again = loop;
  assert.throws(() => fromWireFormatTRecord({ payload: loop }, { validate: false, construct: Construct } as never), error => {
    assert.ok(error instanceof LibError);
    return true;
  });
});

/** A payment wire whose optional `charge` is an own `undefined` value, or an own non-enumerable object. */
function wireWithCharge(charge: 'undefined' | 'hidden'): Record<string, unknown> {
  const wire: Record<string, unknown> = { id: 'p1', note: 'n', merchant: { id: 'm', name: 'M' }, billing: { name: 'B' }, money: { amount: '1.00', currency: 'USD' } };
  if (charge === 'undefined') wire.charge = undefined;
  else Object.defineProperty(wire, 'charge', { value: { id: 'c', status: 'pending', settlesOn: 'later' }, enumerable: false });
  return wire;
}

function hasOwnCharge(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'charge');
}

test('fromWireFormat leaves out a field that is undefined or not enumerable in the wire', async (t) => {
  const { fromWireFormatTPayment } = await loadCodecs(t, 'payment');
  assert.equal(hasOwnCharge(fromWireFormatTPayment(wireWithCharge('undefined'), { validate: false })), false);
  assert.equal(hasOwnCharge(fromWireFormatTPayment(wireWithCharge('hidden'), { validate: false })), false);
});

test('the generated constructor and decode leave out a field that is undefined or not enumerable in the input', async (t) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-serde-isolation-', name: 'serde-isolation', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'payment.model.ts'), readFixture('models/serde-isolation/payment.model.ts'));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const { Payment } = await import(pathToFileURL(path.join(root, 'build/payment.model.js')).href);
  assert.equal(hasOwnCharge(new Payment(wireWithCharge('undefined'))), false);
  assert.equal(hasOwnCharge(new Payment(wireWithCharge('hidden'))), false);
  assert.equal(hasOwnCharge(decodeGeneratedModel(Payment, wireWithCharge('undefined'))), false);
  assert.equal(hasOwnCharge(decodeGeneratedModel(Payment, wireWithCharge('hidden'))), false);
});

/** Builds one model file, imports its generated codecs and gives the URL of its model module. */
async function loadModel(t: TestContext, name: string): Promise<{ codecs: Record<string, FromWire>; modelUrl: string }> {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-serde-isolation-', name: 'serde-isolation', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, `${name}.model.ts`), readFixture(`models/serde-isolation/${name}.model.ts`));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const codecs: Record<string, FromWire> = await import(pathToFileURL(path.join(root, `build/${name}.model.generated.js`)).href);
  return { codecs, modelUrl: pathToFileURL(path.join(root, `build/${name}.model.js`)).href };
}

function ownKeys(value: unknown, field?: string): readonly string[] {
  const target = field === undefined ? value : typeof value === 'object' && value !== null ? Reflect.get(value, field) : undefined;
  return typeof target === 'object' && target !== null ? Object.keys(target).sort() : [];
}

function stampsWire(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 's1', at: '2026-01-01T00:00:00.000Z', stamps: { y: '2026-01-02T00:00:00.000Z' }, ...change };
}

test('the generated constructor and decode read each declared field once', async (t) => {
  const { modelUrl } = await loadModel(t, 'payment');
  const { Payment } = await import(modelUrl);
  let reads = 0;
  const wire = (): Record<string, unknown> => Object.defineProperty(wireWithCharge('undefined'), 'billing', { enumerable: true, get() { reads++; return { name: 'B' }; } });
  new Payment(wire());
  assert.equal(reads, 1);
  reads = 0;
  // The trusted entry runs the generated decode alone, without the caller's cycle check of the input.
  decodeGeneratedModelTrusted(Payment, wire());
  assert.equal(reads, 1);
});

test('decode leaves out an undeclared key whose value is undefined', async (t) => {
  const { codecs, modelUrl } = await loadModel(t, 'stamps');
  const { Stamps } = await import(modelUrl);
  const { fromWireFormatTBag } = await loadCodecs(t, 'bag');
  const wire = stampsWire({ stamps: { x: undefined, y: '2026-01-02T00:00:00.000Z' } });
  assert.deepEqual(ownKeys(codecs.fromWireFormatTStamps(wire, { validate: false }), 'stamps'), ['y']);
  assert.deepEqual(ownKeys(decodeGeneratedModel(Stamps, wire), 'stamps'), ['y']);
  assert.deepEqual(ownKeys(fromWireFormatTBag({ k: undefined, j: 'v' }, { validate: false })), ['j']);
});

test('fromWireFormat leaves out a required or optional field that is undefined, and an optional one that is not enumerable', async (t) => {
  const { codecs } = await loadModel(t, 'stamps');
  const decode = (wire: Record<string, unknown>): readonly string[] => ownKeys(codecs.fromWireFormatTStamps(wire, { validate: false }));
  assert.deepEqual(decode(stampsWire({ id: undefined })), ['at', 'stamps']);
  assert.deepEqual(decode(stampsWire({ at: undefined })), ['id', 'stamps']);
  assert.deepEqual(decode(stampsWire({ label: undefined })), ['at', 'id', 'stamps']);
  assert.deepEqual(decode(Object.defineProperty(stampsWire(), 'label', { value: 'l', enumerable: false })), ['at', 'id', 'stamps']);
  assert.deepEqual(decode(stampsWire({ label: 'l' })), ['at', 'id', 'label', 'stamps']);
});

test('a union tag that is inherited or not enumerable selects no branch', async (t) => {
  const { fromWireFormatTContact } = await loadCodecs(t, 'union');
  const unknownTag = (error: unknown): boolean => {
    assert.ok(error instanceof LibError);
    assert.deepEqual(error.issues[0]?.path, ['value', 'kind']);
    return true;
  };
  const inherited = Object.assign(Object.create({ kind: 'email' }), { address: 'a@example.com' });
  const hidden = Object.defineProperty({ address: 'a@example.com' }, 'kind', { value: 'email', enumerable: false });
  assert.throws(() => fromWireFormatTContact({ value: inherited }, { validate: false }), unknownTag);
  assert.throws(() => fromWireFormatTContact({ value: hidden }, { validate: false }), unknownTag);
});

test('a conversion that fails inside a nested model reports the outer field, the index and the inner field', async (t) => {
  const { fromWireFormatTCalendar } = await loadCodecs(t, 'calendar');
  const note = {};
  assert.throws(() => fromWireFormatTCalendar({ title: 't', event: { at: 'not a date' }, events: [] }, { validate: false }), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Deserialization);
    assert.deepEqual(error.issues[0]?.path, ['event', 'at']);
    return true;
  });
  assert.throws(() => fromWireFormatTCalendar({ title: 't', event: { at: '2026-01-01T00:00:00Z', note }, events: [{ at: '2026-01-01T00:00:00Z' }, { at: '2026-01-02T00:00:00Z' }, { at: 'x' }] }, { validate: false }), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.deepEqual(error.issues[0]?.path, ['events', 2, 'at']);
    return true;
  });
  const decoded = fromWireFormatTCalendar({ title: 't', event: { at: '2026-01-01T00:00:00Z', note }, events: [] }, { validate: false }) as { event: { at: unknown; note: unknown } };
  assert.ok(decoded.event.at instanceof Date);
  assert.strictEqual(decoded.event.note, note);
});

test('generated decode copies every level of closed nested objects and rejects a cycle at depth two', async (t) => {
  const { fromWireFormatTOuter } = await loadCodecs(t, 'outer');
  const input = { inner: { deep: { x: 1 } } };
  const decoded = fromWireFormatTOuter(input, { validate: false }) as typeof input;
  input.inner.deep.x = 2;
  assert.equal(decoded.inner.deep.x, 1);
  assert.notStrictEqual(decoded.inner.deep, input.inner.deep);

  const deep: Record<string, unknown> = { x: 1 };
  deep.extra = deep;
  assert.throws(() => fromWireFormatTOuter({ inner: { deep } }, { validate: false }), cycleAt(['inner', 'deep', 'extra']));
  const outer: { inner: { deep: Record<string, unknown> } } = { inner: { deep: { x: 1 } } };
  outer.inner.deep.extra = outer;
  // The cycle is found by the fill of `deep`, which checks `extra`, so the path runs on to the repeated `deep`.
  assert.throws(() => fromWireFormatTOuter(outer, { validate: false }), cycleAt(['inner', 'deep', 'extra', 'inner', 'deep']));
});

test('generated decode copies maps and arrays and carries only unknown values by reference', async (t) => {
  const { fromWireFormatTContainers } = await loadCodecs(t, 'containers');
  const open = Object.assign(Object.create(null) as Record<string, unknown>, { id: 'o', note: { n: 1 } });
  const wire = { flags: { a: 'x', b: 'y' }, tags: ['t1', 't2'], matrix: [['m']], open, payload: { deep: [1] } };
  const decoded = fromWireFormatTContainers(wire, { validate: false }) as typeof wire;
  assert.notStrictEqual(decoded.flags, wire.flags);
  assert.deepEqual(decoded.flags, wire.flags);
  assert.notStrictEqual(decoded.tags, wire.tags);
  assert.deepEqual(decoded.tags, wire.tags);
  assert.notStrictEqual(decoded.matrix, wire.matrix);
  assert.notStrictEqual(decoded.matrix[0], wire.matrix[0]);
  assert.deepEqual(decoded.matrix, wire.matrix);
  assert.notStrictEqual(decoded.open, wire.open);
  assert.deepEqual({ ...decoded.open }, { id: 'o', note: { n: 1 } });
  assert.strictEqual(decoded.payload, wire.payload);
  wire.flags.a = 'changed';
  wire.tags.push('t3');
  assert.deepEqual(decoded.flags, { a: 'x', b: 'y' });
  assert.deepEqual(decoded.tags, ['t1', 't2']);
  const flags = JSON.parse('{"__proto__":"p","k":"v"}') as Record<string, string>;
  const kept = fromWireFormatTContainers({ ...wire, flags }, { validate: false }) as typeof wire;
  assert.equal(Object.getPrototypeOf(kept.flags), Object.prototype);
  assert.equal(Object.hasOwn(kept.flags, '__proto__'), true);
});

test('generated decode of a recursive model rejects a cycle instead of overflowing the stack', async (t) => {
  const { fromWireFormatTNode } = await loadCodecs(t, 'recursive');
  const node: { label: string; children: unknown[] } = { label: 'root', children: [] };
  node.children = [node];
  assert.throws(() => fromWireFormatTNode(node, { validate: false }), cycleAt(['children', 0]));
  const shared = { label: 'leaf', children: [] };
  assert.deepEqual(fromWireFormatTNode({ label: 'root', children: [shared, shared] }, { validate: false }), { label: 'root', children: [shared, shared] });
});

class Construct { constructor(public fields: unknown) {} }

for (const [name, options] of [['default options', undefined], ['validate: true', { validate: true }], ['validate: true with construct', { validate: true, construct: Construct }]] as const) {
  test(`validated decode of a cyclic recursive value throws a deserialization error instead of overflowing the stack, with ${name}`, async (t) => {
    // protects: T-278 a cyclic value decoded with validation on throws a deserialization LibError, not a RangeError
    const { fromWireFormatTTree, fromWireFormatTNode } = await loadCodecs(t, 'recursive', true);
    const self: { next?: unknown } = {};
    self.next = self;
    const toRoot: { next?: unknown } = { next: {} };
    (toRoot.next as { next?: unknown }).next = toRoot;
    const node: { label: string; children: unknown[] } = { label: 'root', children: [] };
    node.children = [node];
    assert.throws(() => fromWireFormatTTree(self, options as never), cycleAt(['next']));
    assert.throws(() => fromWireFormatTTree(toRoot, options as never), cycleAt(['next', 'next']));
    assert.throws(() => fromWireFormatTNode(node, options as never), cycleAt(['children', 0]));
  });
}

test('validated decode of a recursive value that holds no cycle succeeds', async (t) => {
  // protects: T-278 the cycle check leaves a value without a cycle decoding as before
  const { fromWireFormatTTree, fromWireFormatTNode } = await loadCodecs(t, 'recursive', true);
  assert.deepEqual(fromWireFormatTNode({ label: 'root', children: [] }, { validate: true }), { label: 'root', children: [] });
  assert.deepEqual(fromWireFormatTTree({ next: { next: {} } }, { validate: true }), { next: { next: {} } });
});

/** A chain of `length` objects linked by `next` whose getter counts every read, standing in for the visits of one decode. */
function countedChain(length: number, counter: { reads: number }): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let index = 1; index < length; index++) {
    const next = node;
    node = {};
    Object.defineProperty(node, 'next', { enumerable: true, get() { counter.reads++; return next; } });
  }
  return node;
}

test('generated decode of a recursive object visits each level once', async (t) => {
  const { fromWireFormatTTree } = await loadCodecs(t, 'recursive');
  const visits = (length: number): number => {
    const counter = { reads: 0 };
    fromWireFormatTTree(countedChain(length, counter), { validate: false });
    return counter.reads;
  };
  const fifty = visits(50);
  const hundred = visits(100);
  assert.equal(fifty, 49);
  assert.equal(hundred, 99);
});

test('a rejected cycle leaves no decode state behind', async (t) => {
  const { fromWireFormatTTree, fromWireFormatTNode } = await loadCodecs(t, 'recursive');
  const tree: { next?: unknown } = {};
  tree.next = tree;
  assert.throws(() => fromWireFormatTTree(tree, { validate: false }), cycleAt(['next']));
  delete tree.next;
  assert.deepEqual(fromWireFormatTTree(tree, { validate: false }), {});
  assert.deepEqual(fromWireFormatTTree({ next: { next: {} } }, { validate: false }), { next: { next: {} } });
  class Construct { constructor(public fields: unknown) {} }
  const node: { label: string; children: unknown[] } = { label: 'root', children: [] };
  node.children = [node];
  assert.throws(() => fromWireFormatTNode(node, { validate: false, construct: Construct } as never), cycleAt(['children', 0]));
  node.children = [];
  assert.ok(fromWireFormatTNode(node, { validate: false, construct: Construct } as never) instanceof Construct);
});

test('a decoder that user code runs during a parse still checks its own input for cycles', async (t) => {
  const { fromWireFormatTTree, parseTTree } = await loadCodecs(t, 'recursive') as Record<string, FromWire> & { parseTTree: (text: string, options?: unknown) => unknown };
  const cyclic: { next?: unknown } = {};
  cyclic.next = cyclic;
  let inner: unknown;
  class Construct {
    constructor(public fields: unknown) {
      try { fromWireFormatTTree(cyclic, { validate: false }); } catch (error) { inner = error; }
    }
  }
  assert.ok(parseTTree('{"next":{}}', { validate: false, construct: Construct }) instanceof Construct);
  assert.ok(inner instanceof LibError);
  assert.equal(inner.kind, LibErrorKind.Deserialization);
  assert.match(inner.message, /Cyclic values cannot be converted/);
  assert.throws(() => decodeGeneratedModel(RecordModel, { payload: cyclic }), cycleAt(['payload', 'next']));
});

test('parsed JSON text is decoded without cycle checks', async (t) => {
  const { fromWireFormatTTree, parseTTree } = await loadCodecs(t, 'recursive') as Record<string, FromWire> & { parseTTree: (text: string, options?: { validate?: boolean }) => unknown };
  assert.deepEqual(parseTTree('{"next":{"next":{}}}', { validate: false }), { next: { next: {} } });
  const tree: { next?: unknown } = {};
  tree.next = tree;
  assert.throws(() => fromWireFormatTTree(tree, { validate: false }), cycleAt(['next']));
});

function generatedSource(t: TestContext, name: string): string {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-serde-isolation-',
    name: 'serde-isolation',
    linkWorkspaceNodeModules: true,
  });
  fs.writeFileSync(path.join(sourceRoot, `${name}.model.ts`), readFixture(`models/serde-isolation/${name}.model.ts`));
  const artifact = generate({ root, profile: { mobx: false, validation: false } }).artifacts.find((item) => item.path.endsWith(`${name}.model.generated.ts`));
  assert.ok(artifact);
  return artifact.content;
}

test('fill paths pass converters as module-level functions, not per-value closures', (t) => {
  const source = generatedSource(t, 'calendar');
  // Kept pins (here and below): the claim is an allocation budget of the emitted code, which only its text shows; the conversion results are proven by the tests above.
  assert.match(source, /convertModelField\("deserialize", "event", __golemDecode_TCalendar_\d+, /);
  assert.match(source, /convertModelItems\("deserialize", __golemDecode_TCalendar_\d+, \w+ as readonly unknown\[\]\)/);
  assert.doesNotMatch(source, /convertModelField\("deserialize", [^\n]*, \(\w+\) =>/);
});

test('a nested fill that cannot throw runs without a conversion scope', (t) => {
  const source = generatedSource(t, 'nested');
  const fill = /function fillTTop[\s\S]*?\n}\n/.exec(source)?.[0];
  assert.ok(fill);
  assert.match(fill, /out\["middle"\] = fillTMiddle\(/);
  assert.doesNotMatch(fill, /convertModelField/);
});

test('a nested union reads its tag once', async (t) => {
  const { fromWireFormatTContact } = await loadCodecs(t, 'union');
  let reads = 0;
  const value = { address: 'a@example.com' };
  Object.defineProperty(value, 'kind', { enumerable: true, get() { reads++; return 'email'; } });
  assert.deepEqual({ ...(fromWireFormatTContact({ value }, { validate: false }) as { value: object }).value }, { kind: 'email', address: 'a@example.com' });
  assert.equal(reads, 1);
  assert.throws(() => fromWireFormatTContact({ value: { kind: 'fax' } }, { validate: false }), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.deepEqual(error.issues[0]?.path, ['value', 'kind']);
    return true;
  });
});

test('an open object without declared fields keeps an own __proto__ key instead of changing the prototype', async (t) => {
  const { fromWireFormatTBag, fromWireFormatTShelfOfBag } = await loadCodecs(t, 'bag');
  const wire = (): Record<string, unknown> => JSON.parse('{"__proto__":{"x":1},"k":"v"}') as Record<string, unknown>;
  const plain = fromWireFormatTBag(wire(), { validate: false }) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(plain), Object.prototype);
  assert.equal(Object.hasOwn(plain, '__proto__'), true);
  assert.equal(plain.k, 'v');
  const nested = (fromWireFormatTShelfOfBag({ bag: wire() }, { validate: false }) as { bag: Record<string, unknown> }).bag;
  assert.equal(Object.getPrototypeOf(nested), Object.prototype);
  assert.equal(Object.hasOwn(nested, '__proto__'), true);
  class Construct { constructor(public fields: Record<string, unknown>) {} }
  const built = fromWireFormatTBag(wire(), { validate: false, construct: Construct } as never) as Construct;
  assert.equal(Object.getPrototypeOf(built.fields), Object.prototype);
  assert.equal(Object.hasOwn(built.fields, '__proto__'), true);
});

test('generated decode copies declared objects and carries unknown values by reference', async (t) => {
  const { fromWireFormatTRecord, fromWireFormatTShelf } = await loadCodecs(t, 'recursive');
  const wire = { payload: { nested: { a: 1 } } };
  const decoded = fromWireFormatTRecord(wire, { validate: false }) as { payload: { nested: { a: number } } };
  wire.payload.nested.a = 2;
  assert.equal(decoded.payload.nested.a, 2);
  assert.strictEqual(decoded.payload, wire.payload);

  const shelf = { owner: { id: 'o' }, extras: { tag: { deep: 1 } } };
  const copy = fromWireFormatTShelf(shelf, { validate: false }) as typeof shelf;
  shelf.owner.id = 'changed';
  assert.equal(copy.owner.id, 'o');
  assert.notStrictEqual(copy.owner, shelf.owner);
  assert.notStrictEqual(copy.extras, shelf.extras);
  assert.strictEqual(copy.extras.tag, shelf.extras.tag);

  const loop: Record<string, unknown> = {};
  loop.again = loop;
  assert.throws(() => fromWireFormatTRecord({ payload: { loop } }, { validate: false }), cycleAt(['payload', 'loop', 'again']));
  assert.throws(() => fromWireFormatTShelf({ owner: { id: 'o' }, extras: { loop } }, { validate: false }), cycleAt(['extras', 'loop', 'again']));
});

test('decode cycle tracking retains multiple contracts and recovers after failure', () => {
  let recurse = true;
  class First {}
  class Second {}
  class Third {}
  registerGeneratedModel(First, { fields: [], profile: { validation: false }, conversion: {
    decode(input) { decodeGeneratedModel(Second, input); return new First(); }, encode: () => ({}),
  } });
  registerGeneratedModel(Second, { fields: [], profile: { validation: false }, conversion: {
    decode(input) { decodeGeneratedModel(Third, input); return new Second(); }, encode: () => ({}),
  } });
  registerGeneratedModel(Third, { fields: [], profile: { validation: false }, conversion: {
    decode(input) { if (recurse) decodeGeneratedModel(First, input); return new Third(); }, encode: () => ({}),
  } });
  const input = {};
  assert.throws(() => decodeGeneratedModel(First, input), error => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Deserialization);
    return true;
  });
  recurse = false;
  assert.ok(decodeGeneratedModel(First, input) instanceof First);
  assert.ok(decodeGeneratedModel(Second, input) instanceof Second);
});
