import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Inventory, TInventory } from './inventory.model.js';
import type { TInventoryJSON } from './inventory.model.generated.js';

export type AliasSame = Assert<Same<WireFormat<TInventory>, TInventoryJSON>>;
export type ClassSame = Assert<Same<WireFormat<Inventory>, TInventoryJSON>>;
export type AliasNotAny = Assert<NotAny<WireFormat<TInventory>>>;
