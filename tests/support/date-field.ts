import { builtinClassByOpenApiFormat, builtinClassDescriptor, code, identifier, type StringifySerdeResolver } from '@exprtlabs/golem/internal/emitter';
import { MODEL_CLASS_KEYWORD, type ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';

/** A Date field as the registry makes it: a class-valued TSerde field whose model holds the instance and whose wire holds its date-time text. */
const DATE_CLASS = builtinClassByOpenApiFormat('date', 'date-time')!;
export const DATE_FIELD: ModelTypeDescriptor = builtinClassDescriptor(DATE_CLASS);

/** The model-plane schema of a Date field: an instance of the global `Date` that also holds a time (`new Date(NaN)` is not valid). */
export const DATE_INSTANCE = { [MODEL_CLASS_KEYWORD]: { name: 'Date', path: ['Date'], valid: DATE_CLASS.serde.valid } };

/** The conversions of `DATE_FIELD`: the runtime's Date codec, which the tests' scope provides from the model runtime under its export name. */
export const DATE_SERDE: StringifySerdeResolver = {
  deserialize: (serde, value) => code`${identifier(serde.deserialize.exportName)}(${value})`,
  serialize: (serde, value) => code`${identifier(serde.serialize.exportName)}(${value})`,
};
