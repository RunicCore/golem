import type { IModel } from '@exprtlabs/golem/model';

export type TItem = IModel<{ title: string; count: number }>;

import { TItemBaseModel } from './item.model.generated.js';

export class Item extends TItemBaseModel {}
