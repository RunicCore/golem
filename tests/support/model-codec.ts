import { findGeneratedModelDefinition, findGeneratedModelDefinitionForConstructor, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import type { GeneratedModelConstructor, GeneratedModelResult } from '@exprtlabs/golem/model';
import type { ObjectCodec, SerdeOptions } from '@exprtlabs/golem/serde';

/** The codec of a model class: `fromWireFormat` builds an instance of that class, as `fromWireFormat<Model>` does after the build rewrite. */
export interface ModelClassCodec<Model> {
  toWireFormat: ObjectCodec<Model>['toWireFormat'];
  fromWireFormat(wire: unknown, options?: Omit<SerdeOptions, 'construct'>): Model;
}

/**
 * The codec of a generated model, found from its class or from one of its instances. Tests that load a built model at
 * run time run without the build rewrite, so they cannot call `toWireFormat<T>` or `fromWireFormat<T>`; they call the
 * codec that the rewrite would bind.
 */
export function modelCodec<Constructor extends GeneratedModelConstructor>(model: Constructor): ModelClassCodec<GeneratedModelResult<Constructor>>;
export function modelCodec<Model extends object>(model: Model): Pick<ObjectCodec<Model>, 'toWireFormat'>;
export function modelCodec(model: object): ModelClassCodec<unknown> {
  const definition = typeof model === 'function' ? findGeneratedModelDefinitionForConstructor(model) : findGeneratedModelDefinition(model);
  if (!definition?.codecId) throw new Error('The model has no registered codec.');
  const codec = requireObjectCodec(definition.codecId);
  const construct = typeof model === 'function' ? model as SerdeOptions['construct'] : undefined;
  return {
    toWireFormat: (value, options) => codec.toWireFormat(value, options),
    fromWireFormat: (wire, options) => codec.fromWireFormat(wire, { ...options, construct }),
  };
}
