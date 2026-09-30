import {
  computed,
  isComputedProp,
  isObservableObject,
  isObservableMap,
  isObservableProp,
  isObservableSet,
  makeObservable,
  observable,
  runInAction,
  type AnnotationMapEntry,
  type AnnotationsMap,
  type IObservableValue,
} from 'mobx';
import { createTrackedApiOperation } from './api-operation.js';
import type {
  ApiOperation,
  ApiOperationRun,
} from './client.js';
import { findGeneratedModelDefinition } from './model.js';

export type ModelAnnotations<Model extends object> = AnnotationsMap<Model, never>;

const observableModels = new WeakSet<object>();

export function asGenObservable<Model extends object>(
  model: Model,
  annotations: ModelAnnotations<Model> = {},
): void {
  if (observableModels.has(model)) {
    throw new Error('asGenObservable() may only be called once per model instance.');
  }
  initializeModel(model, annotations, new WeakSet<object>());
}

function initializeNested(value: unknown, visited: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  if (observableModels.has(value)) return;
  if (findGeneratedModelDefinition(value)) {
    // Preserve annotations supplied by a child's own initialization lifecycle.
    if (isObservableObject(value)) return;
    initializeModel(value, {}, visited);
    return;
  }
  visited.add(value);
  if (value instanceof Map || value instanceof Set || isObservableMap(value) || isObservableSet(value)) {
    for (const item of value.values()) initializeNested(item, visited);
    return;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if ('value' in descriptor) initializeNested(descriptor.value, visited);
    else if (isObservableProp(value, key) && !isComputedProp(value, key)) {
      // Read MobX's stored observable value without evaluating user-defined getters.
      initializeNested(Reflect.get(value, key), visited);
    }
  }
}

function initializeModel<Model extends object>(
  model: Model,
  annotations: ModelAnnotations<Model>,
  visited: WeakSet<object>,
): void {
  const generated = findGeneratedModelDefinition(model);
  if (!generated) throw new TypeError('Generated model metadata is missing.');
  // Mark before descending: models can share children or reference their parent.
  visited.add(model);

  const merged: Record<PropertyKey, AnnotationMapEntry> = Object.create(null);
  for (const field of generated.fields) {
    if (!Object.prototype.hasOwnProperty.call(model, field)) {
      Object.defineProperty(model, field, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined,
      });
    }
    merged[field] = observable;
  }
  Object.assign(merged, annotations);
  for (const field of generated.fields) {
    const annotation = merged[field];
    if (annotation === true || annotation === observable || annotation === observable.deep) {
      initializeNested(Reflect.get(model, field), visited);
    }
  }
  makeObservable(model, merged as AnnotationsMap<Model, never>);
  observableModels.add(model);
}

export interface ObservableApiOperation<Input, Result, Options = unknown>
  extends ApiOperation<Input, Result, Options> {
  readonly loading: boolean;
}

class ObservableApiOperationHandle<Input, Result, Options = unknown>
  implements ObservableApiOperation<Input, Result, Options> {
  public readonly execute: ApiOperation<Input, Result, Options>['execute'];
  readonly #pending: IObservableValue<number>;

  public constructor(
    pending: IObservableValue<number>,
    execute: ApiOperation<Input, Result, Options>['execute'],
  ) {
    this.#pending = pending;
    this.execute = execute;
    makeObservable(this, { loading: computed });
  }

  public get loading(): boolean {
    return this.#pending.get() > 0;
  }
}

export function createObservableApiOperation<Input, Result, Options = unknown>(
  name: string,
  run: ApiOperationRun<Input, Result, Options>,
): ObservableApiOperation<Input, Result, Options> {
  const pending = observable.box(0);
  const operation = createTrackedApiOperation(name, run, (count) => {
    runInAction(() => {
      pending.set(count);
    });
  });
  return new ObservableApiOperationHandle(pending, (input, options) =>
    operation.execute(input, options),
  );
}
