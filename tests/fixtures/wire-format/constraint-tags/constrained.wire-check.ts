import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Constrained, TConstrained } from './constrained.model.js';
import type { TConstrainedJSON } from './constrained.model.generated.js';

export type AliasSame = Assert<Same<WireFormat<TConstrained>, TConstrainedJSON>>;
export type ClassSame = Assert<Same<WireFormat<Constrained>, TConstrainedJSON>>;
export type AliasNotAny = Assert<NotAny<WireFormat<TConstrained>>>;
