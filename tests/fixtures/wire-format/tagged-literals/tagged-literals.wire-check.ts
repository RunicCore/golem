import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, MutuallyAssignable, NotAny, Same } from './wire-assert.js';
import type { TTaggedLiterals } from './tagged-literals.model.js';
import type { TTaggedLiteralsJSON } from './tagged-literals.model.generated.js';

// TypeScript cannot remove a tag from a tagged literal, so the wire type keeps it and is only mutually assignable with the emitted JSON type.
// @ts-expect-error known difference: the wire type keeps the tag of a tagged literal.
export type Identical = Assert<Same<WireFormat<TTaggedLiterals>, TTaggedLiteralsJSON>>;
export type Assignable = Assert<MutuallyAssignable<WireFormat<TTaggedLiterals>, TTaggedLiteralsJSON>>;
export type NotAnyWire = Assert<NotAny<WireFormat<TTaggedLiterals>>>;
