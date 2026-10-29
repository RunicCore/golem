import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autorun,
  isObservableArray,
  isObservableMap,
  isObservableObject,
  isObservableProp,
  isObservableSet,
  makeObservable,
  observable,
  runInAction,
} from 'mobx';

import * as model from '@exprtlabs/golem/internal/model-runtime';
import * as mobxRuntime from '@exprtlabs/golem/mobx';

interface ChildFields {
  value: number;
  payload: { amount: number };
  parent?: GraphModel;
}

class NestedChildModel {
  public value: number;
  public payload: { amount: number };
  public parent?: GraphModel;
  public nested?: NestedChildModel;

  public constructor(value: number, payload: { amount: number } = { amount: value }, nested?: NestedChildModel) {
    this.value = value;
    this.payload = payload;
    this.nested = nested;
  }

}

class ForeignInstance {
  public value = 0;
}

interface GraphFields {
  child: NestedChildModel;
  sharedAlias?: NestedChildModel;
  arrayChildren: NestedChildModel[];
  recordChildren: Record<string, NestedChildModel>;
  mapChildren: Map<string, NestedChildModel>;
  setChildren: Set<NestedChildModel>;
  foreign: ForeignInstance;
  refChild?: NestedChildModel;
  shallowChildren: NestedChildModel[];
  disabledChild?: NestedChildModel;
  structChild?: NestedChildModel;
}

class GraphModel {
  public child: NestedChildModel;
  public sharedAlias?: NestedChildModel;
  public arrayChildren: NestedChildModel[] = [];
  public recordChildren: Record<string, NestedChildModel> = {};
  public mapChildren: Map<string, NestedChildModel> = new Map();
  public setChildren: Set<NestedChildModel> = new Set();
  public foreign: ForeignInstance;
  public refChild?: NestedChildModel;
  public shallowChildren: NestedChildModel[] = [];
  public disabledChild?: NestedChildModel;
  public structChild?: NestedChildModel;

  public constructor(values: Partial<GraphFields> = {}) {
    this.child = values.child ?? new NestedChildModel(0);
    this.foreign = values.foreign ?? new ForeignInstance();
    Object.assign(this, values);
  }

}

model.registerGeneratedModel(NestedChildModel, {
  fields: ['value', 'payload', 'parent', 'nested'],
});
model.registerGeneratedModel(GraphModel, {
  fields: [
    'child',
    'sharedAlias',
    'arrayChildren',
    'recordChildren',
    'mapChildren',
    'setChildren',
    'foreign',
    'refChild',
    'shallowChildren',
    'disabledChild',
    'structChild',
  ],
});

function child(value: number, payload?: { amount: number }, nested?: NestedChildModel): NestedChildModel {
  return new NestedChildModel(value, payload, nested);
}

test('one concrete root initializes generated children in supported containers', () => {
  const arrayChild = child(2);
  const recordChild = child(3);
  const mapChild = child(4);
  const setChild = child(5);
  const foreign = new ForeignInstance();
  const root = new GraphModel({
    child: child(1),
    arrayChildren: [arrayChild],
    recordChildren: { record: recordChild },
    mapChildren: new Map([['map', mapChild]]),
    setChildren: new Set([setChild]),
    foreign,
  });

  mobxRuntime.asGenObservable(root);

  assert.equal(isObservableObject(root), true);
  for (const nested of [root.child, arrayChild, recordChild, mapChild, setChild]) {
    assert.equal(isObservableObject(nested), true);
    assert.equal(isObservableProp(nested, 'value'), true);
  }
  assert.equal(isObservableObject(foreign), false);
  assert.equal(isObservableProp(foreign, 'value'), false);

  const observed: number[] = [];
  const dispose = autorun(() => observed.push(
    root.child.value
      + root.arrayChildren[0].value
      + root.recordChildren.record.value
      + (root.mapChildren.get('map')?.value ?? 0)
      + ([...root.setChildren][0]?.value ?? 0),
  ));
  runInAction(() => {
    root.child.value = 11;
    arrayChild.value = 12;
    recordChild.value = 13;
    mapChild.value = 14;
    setChild.value = 15;
  });
  assert.deepEqual(observed, [15, 65]);
  dispose();
});

test('shared generated references and generated-model cycles terminate', () => {
  const shared = child(1);
  const root = new GraphModel({ child: shared, sharedAlias: shared });
  shared.parent = root;

  assert.doesNotThrow(() => mobxRuntime.asGenObservable(root));
  assert.strictEqual(root.child, shared);
  assert.strictEqual(root.sharedAlias, shared);
  assert.equal(isObservableProp(shared, 'value'), true);

  const observed: number[] = [];
  const dispose = autorun(() => observed.push(root.child.value + (root.sharedAlias?.value ?? 0)));
  runInAction(() => {
    shared.value = 2;
  });
  assert.deepEqual(observed, [2, 4]);
  dispose();
});

test('root preserves a generated child initialized directly by MobX as an opaque boundary', () => {
  const descendant = child(2);
  const payload = { amount: 1 };
  const externallyInitialized = child(1, payload, descendant);
  makeObservable(externallyInitialized, { value: observable, payload: observable.ref });
  const root = new GraphModel({ child: externallyInitialized });

  mobxRuntime.asGenObservable(root);

  assert.equal(isObservableObject(externallyInitialized), true);
  assert.equal(isObservableProp(externallyInitialized, 'value'), true);
  assert.equal(isObservableProp(externallyInitialized, 'payload'), true);
  assert.strictEqual(externallyInitialized.payload, payload);
  assert.strictEqual(externallyInitialized.nested, descendant);
  assert.equal(isObservableProp(descendant, 'value'), false);
});

test('explicit deep annotations recurse while struct preserves a nested model as a reference', () => {
  const explicit = child(1, undefined, child(2));
  const deep = child(3, undefined, child(4));
  const struct = child(5, undefined, child(6));
  const root = new GraphModel({ child: explicit, sharedAlias: deep, structChild: struct });

  mobxRuntime.asGenObservable(root, {
    child: true,
    sharedAlias: observable.deep,
    structChild: observable.struct,
  });

  assert.equal(isObservableProp(explicit.nested!, 'value'), true);
  assert.equal(isObservableProp(deep.nested!, 'value'), true);
  assert.equal(isObservableProp(struct.nested!, 'value'), false);
});

test('already observable containers are traversed and plain enumerable getters are not invoked', () => {
  const arrayChild = child(2);
  const recordChild = child(3);
  const mapChild = child(4);
  const setChild = child(5);
  const observableRecord = observable.object({ record: recordChild }) as Record<string, NestedChildModel>;
  const observableArray = observable.array([arrayChild]);
  const observableMap = observable.map([['map', mapChild]]);
  const observableSet = observable.set([setChild]);
  const root = new GraphModel({
    child: child(1),
    arrayChildren: observableArray,
    recordChildren: observableRecord,
    mapChildren: observableMap,
    setChildren: observableSet,
  });

  mobxRuntime.asGenObservable(root);

  assert.equal(isObservableArray(root.arrayChildren), true);
  assert.equal(isObservableMap(root.mapChildren), true);
  assert.equal(isObservableSet(root.setChildren), true);
  for (const nested of [arrayChild, recordChild, mapChild, setChild]) {
    assert.equal(isObservableProp(nested, 'value'), true);
  }
  const observed: number[] = [];
  const dispose = autorun(() => observed.push(
    root.arrayChildren[0].value
      + root.recordChildren.record.value
      + (root.mapChildren.get('map')?.value ?? 0)
      + ([...root.setChildren][0]?.value ?? 0),
  ));
  runInAction(() => {
    arrayChild.value = 12;
    recordChild.value = 13;
    mapChild.value = 14;
    setChild.value = 15;
  });
  assert.deepEqual(observed, [14, 54]);
  dispose();

  let getterReads = 0;
  const getterChild = child(6);
  const getterRecord: Record<string, NestedChildModel> = {};
  Object.defineProperty(getterRecord, 'getter', {
    configurable: true,
    enumerable: true,
    get: () => {
      getterReads += 1;
      return getterChild;
    },
  });
  const getterRoot = new GraphModel({ child: child(0), recordChildren: getterRecord });

  mobxRuntime.asGenObservable(getterRoot);

  assert.equal(getterReads, 0);
  assert.equal(isObservableProp(getterChild, 'value'), false);
});

test('already initialized children keep identity, annotations, and duplicate-call errors', () => {
  const payload = { amount: 1 };
  const nested = child(1, payload);
  mobxRuntime.asGenObservable(nested, { payload: observable.ref });
  const root = new GraphModel({ child: nested });

  mobxRuntime.asGenObservable(root);

  assert.strictEqual(root.child, nested);
  assert.strictEqual(nested.payload, payload);
  assert.equal(isObservableProp(nested, 'payload'), true);
  const observed: number[] = [];
  const dispose = autorun(() => observed.push(nested.payload.amount));
  runInAction(() => {
    payload.amount = 2;
  });
  assert.deepEqual(observed, [1]);
  dispose();

  assert.throws(
    () => mobxRuntime.asGenObservable(root),
    /asGenObservable\(\) may only be called once/,
  );
});

test('false, ref, and shallow overrides prevent opted-out nested initialization', () => {
  const refChild = child(1);
  const shallowChild = child(2);
  const disabledChild = child(3);
  const root = new GraphModel({
    child: child(0),
    refChild,
    shallowChildren: [shallowChild],
    disabledChild,
  });

  mobxRuntime.asGenObservable(root, {
    refChild: observable.ref,
    shallowChildren: observable.shallow,
    disabledChild: false,
  });

  assert.equal(isObservableProp(root, 'refChild'), true);
  assert.equal(isObservableProp(root, 'shallowChildren'), true);
  assert.equal(isObservableProp(root, 'disabledChild'), false);
  assert.equal(isObservableProp(refChild, 'value'), false);
  assert.equal(isObservableProp(shallowChild, 'value'), false);
  assert.equal(isObservableProp(disabledChild, 'value'), false);

  const refObserved: number[] = [];
  const shallowObserved: number[] = [];
  const disabledObserved: number[] = [];
  const disposeRef = autorun(() => refObserved.push(root.refChild?.value ?? 0));
  const disposeShallow = autorun(() => shallowObserved.push(root.shallowChildren[0]?.value ?? 0));
  const disposeDisabled = autorun(() => disabledObserved.push(root.disabledChild?.value ?? 0));
  runInAction(() => {
    refChild.value = 11;
    shallowChild.value = 12;
    disabledChild.value = 13;
  });
  assert.deepEqual(refObserved, [1]);
  assert.deepEqual(shallowObserved, [2]);
  assert.deepEqual(disabledObserved, [3]);

  disposeRef();
  disposeShallow();
  disposeDisabled();
});
