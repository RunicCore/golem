import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Tuple, TTuple } from './tuple.model.js';
import type { TTupleJSON } from './tuple.model.generated.js';

export type AliasSame = Assert<Same<WireFormat<TTuple>, TTupleJSON>>;
export type ClassSame = Assert<Same<WireFormat<Tuple>, TTupleJSON>>;
export type AliasNotAny = Assert<NotAny<WireFormat<TTuple>>>;
