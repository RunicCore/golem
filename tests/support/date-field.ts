import { builtinClassByOpenApiFormat, builtinClassDescriptor, code, identifier, type StringifySerdeResolver } from '@exprtlabs/golem/internal/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';

/** A Date field as the registry makes it: a class-valued TSerde field whose model holds the instance and whose wire holds its date-time text. */
export const DATE_FIELD: ModelTypeDescriptor = builtinClassDescriptor(builtinClassByOpenApiFormat('date', 'date-time')!);

/** The conversions of `DATE_FIELD`: the runtime's Date codec, which the tests' scope provides from the model runtime under its export name. */
export const DATE_SERDE: StringifySerdeResolver = {
  deserialize: (serde, value) => code`${identifier(serde.deserialize.exportName)}(${value})`,
  serialize: (serde, value) => code`${identifier(serde.serialize.exportName)}(${value})`,
};
