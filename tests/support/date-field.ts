import { code, type StringifySerdeResolver } from '@exprtlabs/golem/internal/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';

/** A Date field as a class-valued TSerde field: the model holds the instance, the wire holds its date-time text. */
export const DATE_FIELD: ModelTypeDescriptor = {
  kind: 'class-value',
  typeName: 'Date',
  classRef: { path: ['Date'] },
  serde: { id: 'date', wire: { kind: 'string', constraints: [{ kind: 'format', value: 'date-time' }] } },
};

/** The conversions of `DATE_FIELD`: the runtime's Date codec, which the tests' scope provides from the model runtime. */
export const DATE_SERDE: StringifySerdeResolver = {
  deserialize: (_id, value) => code`deserializeDate(${value})`,
  serialize: (_id, value) => code`serializeDate(${value})`,
};
