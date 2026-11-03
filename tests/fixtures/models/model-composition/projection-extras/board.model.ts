import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TBoardBaseModel } from './board.model.generated.js';
export type TSlot = IObject<{ at: Date }>;
export type TSlots = IObject<{ main: TSlot; [key: string]: TSlot }>;
export type TBoard = IModel<{ slots: Omit<TSlots, 'main'> }>;
export class Board extends TBoardBaseModel {}
