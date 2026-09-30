
import type { IModel } from '@exprtlabs/golem/model';
import { Item } from './item.model.js';
export type TParent = IModel<{ child: Item | null }>;
