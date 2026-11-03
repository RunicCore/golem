import type { IModel } from '@exprtlabs/golem/model';

export type TItem = IModel<{ id: string; name: string; note?: string }>;
// A projection alias whose type parameter has a default: one field writes it bare, the other passes the argument.
type Without<T = TItem> = Omit<T, 'note'>;
export type TCatalog = IModel<{ bare: Without; explicit: Without<TItem> }>;
