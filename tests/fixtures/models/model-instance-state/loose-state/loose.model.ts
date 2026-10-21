import type { IModel } from '@exprtlabs/golem/model';
import { TLooseBaseModel, TLooseNoteBaseModel, type TLooseFields, type TLooseNoteFields } from './loose.model.generated.js';
// The project sets exact: false, so a model with no tag is open by default and declares no map.
export type TLoose = IModel<{ id: string }>;
export type TLooseNote = IModel<{ title: string; data: unknown }, { allowAny: true }>;
export class Loose extends TLooseBaseModel {
  constructor(values: Partial<TLooseFields> = {}) { super(values); }
}
export class LooseNote extends TLooseNoteBaseModel {
  constructor(values: Partial<TLooseNoteFields> = {}) { super(values); }
}
