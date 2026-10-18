import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Stamped, TStamped } from './stamped.model.js';
import type { TStampedJSON } from './stamped.model.generated.js';

export type AliasSame = Assert<Same<WireFormat<TStamped>, TStampedJSON>>;
export type ClassSame = Assert<Same<WireFormat<Stamped>, TStampedJSON>>;
export type AliasNotAny = Assert<NotAny<WireFormat<TStamped>>>;
export type DateIsString = Assert<Same<WireFormat<{ at: Date }>, { at: string }>>;
export type SerdeIsDeserializerInput = Assert<Same<WireFormat<TStamped>['level'], string>>;
// @ts-expect-error A Date field is a string on the wire.
export type DateStaysDate = Assert<Same<WireFormat<{ at: Date }>, { at: Date }>>;
// @ts-expect-error any is not a wire type.
export type AnyWire = Assert<NotAny<WireFormat<any>>>;
