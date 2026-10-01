// #region object-and-model
import type { IModel, IObject } from '@exprtlabs/golem/model';
import { NotebookBaseModel } from './note.model.generated.js';

export type TNote = IObject<{ text: string }>;
export type TNotebook = IModel<{ notes: TNote[] }>;
export class Notebook extends NotebookBaseModel {}
// #endregion object-and-model
