// #region object-and-model
import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TThreadBaseModel } from './comment.model.generated.js';

export type TComment = IObject<{ text: string }>;
export type TThread = IModel<{ comments: TComment[] }>;
export class Thread extends TThreadBaseModel {}
// #endregion object-and-model
