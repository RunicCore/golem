import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel } from './item.model.generated.js';
import type { TChild } from './child.model.js';
export type TItem = IModel<{ id: number; label: string; child: TChild }>;
export class Item extends TItemBaseModel {}
export const setterCalls = { count: 0 };
/** A subclass whose prototype holds an accessor for a plain field (id) and one for a field the constructor converts (child). */
export class Guarded extends TItemBaseModel {}
for (const field of ['id', 'child']) {
  Object.defineProperty(Guarded.prototype, field, {
    configurable: true,
    get(): unknown { return undefined; },
    set(_value: unknown): void { setterCalls.count += 1; },
  });
}
