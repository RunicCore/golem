import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Snapshot, TSnapshot } from './snapshot.model.js';
import type { TSnapshotJSON } from './snapshot.model.generated.js';

export type AliasSame = Assert<Same<WireFormat<TSnapshot>, TSnapshotJSON>>;
export type ClassSame = Assert<Same<WireFormat<Snapshot>, TSnapshotJSON>>;
export type AliasNotAny = Assert<NotAny<WireFormat<TSnapshot>>>;
