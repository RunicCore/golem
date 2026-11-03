import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { TWireKinds, WireKinds } from './wire-kinds.model.js';
import type { TWireKindsJSON } from './wire-kinds.model.generated.js';

export type AliasSame = Assert<Same<WireFormat<TWireKinds>, TWireKindsJSON>>;
export type ClassSame = Assert<Same<WireFormat<WireKinds>, TWireKindsJSON>>;
export type AliasNotAny = Assert<NotAny<WireFormat<TWireKinds>>>;
export type ClassNotAny = Assert<NotAny<WireFormat<WireKinds>>>;
