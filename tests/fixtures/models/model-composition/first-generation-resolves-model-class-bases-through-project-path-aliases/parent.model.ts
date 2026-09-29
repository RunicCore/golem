
import type { IModel } from '@exprtlabs/codegen/model';
import { Item } from './item.model.js';
export type TParent = IModel<{ child: Item | null }>;
