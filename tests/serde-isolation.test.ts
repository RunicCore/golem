import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { decodeGeneratedModel, decodeGeneratedModelTrusted } from '@exprtlabs/golem/conversion';
import { registerGeneratedModel } from '@exprtlabs/golem/model';
import { LibError, LibErrorKind, IssueCode, IssueSource, IssueRepresentation } from '@exprtlabs/golem/errors';
import { generate } from '#model/generator';
import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject } from './model-project.js';

type FromWire = (wire: unknown, options?: { validate?: boolean }) => unknown;

function cycleAt(path: readonly (string | number)[]): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Deserialization);
    assert.equal(error.issues[0]?.code, IssueCode.Deserialization);
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

async function loadCodecs(t: TestContext, name: string): Promise<Record<string, FromWire>> {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-serde-isolation-',
    name: 'serde-isolation',
    ttscPlugin: true,
    linkWorkspaceNodeModules: true,
  });
  fs.writeFileSync(path.join(sourceRoot, `${name}.model.ts`), readFixture(`models/serde-isolation/${name}.model.ts`));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: false } }).artifacts);
  await compileModelProject(root);
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

test('a conversion that fails inside a nested model reports the field that holds it', async (t) => {
  const { fromWireFormatTCalendar } = await loadCodecs(t, 'calendar');
  const note = {};
  assert.throws(() => fromWireFormatTCalendar({ title: 't', event: { at: 'not a date' }, events: [] }, { validate: false }), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Deserialization);
    assert.deepEqual(error.issues[0]?.path, ['event']);
    return true;
  });
  assert.throws(() => fromWireFormatTCalendar({ title: 't', event: { at: '2026-01-01T00:00:00Z', note }, events: [{ at: 'x' }] }, { validate: false }), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.deepEqual(error.issues[0]?.path, ['events']);
    return true;
  });
  const decoded = fromWireFormatTCalendar({ title: 't', event: { at: '2026-01-01T00:00:00Z', note }, events: [] }, { validate: false }) as { event: { at: unknown; note: unknown } };
  assert.ok(decoded.event.at instanceof Date);
  assert.strictEqual(decoded.event.note, note);
});

test('generated decode of a recursive model or object rejects a cycle instead of overflowing the stack', async (t) => {
  const { fromWireFormatTNode, fromWireFormatTTree } = await loadCodecs(t, 'recursive');
  const node: { label: string; children: unknown[] } = { label: 'root', children: [] };
  node.children = [node];
  assert.throws(() => fromWireFormatTNode(node, { validate: false }), cycleAt(['children', 0]));
  const tree: { next?: unknown } = {};
  tree.next = tree;
  assert.throws(() => fromWireFormatTTree(tree, { validate: false }), cycleAt(['next']));
  const shared = { label: 'leaf', children: [] };
  assert.deepEqual(fromWireFormatTNode({ label: 'root', children: [shared, shared] }, { validate: false }), { label: 'root', children: [shared, shared] });
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
  assert.strictEqual(copy.extras, shelf.extras);

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
