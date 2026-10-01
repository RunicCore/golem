// #region object-and-model
import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TNotebookBaseModel } from './note.model.generated.js';

export type TNote = IObject<{ text: string }>;
export type TNotebook = IModel<{ notes: TNote[] }>;
export class Notebook extends TNotebookBaseModel {}
// #endregion object-and-model
