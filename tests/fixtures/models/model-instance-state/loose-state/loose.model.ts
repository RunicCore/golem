import type { IModel } from '@exprtlabs/golem/model';
import type { AdditionalProperties } from '@exprtlabs/golem/tags';
import { TLooseBaseModel, TLooseNoteBaseModel, TOpenBaseModel, TShapeBaseModel, type TLooseFields, type TLooseNoteFields, type TOpenFields, type TShapeFields } from './loose.model.generated.js';
// The project sets exact: false, so a model with no tag is open by default and declares no map.
export type TLoose = IModel<{ id: string }>;
export type TLooseNote = IModel<{ title: string; data: unknown }, { allowAny: true }>;
// An explicit additionalProperties tag: the extra keys are data.
export type TOpen = IModel<{ id: string } & AdditionalProperties<unknown>>;
export type TShape = IModel<{ tagged: { known: string } & AdditionalProperties<unknown>; plain: { known: string } }>;
export class Loose extends TLooseBaseModel {
  constructor(values: Partial<TLooseFields> = {}) { super(values); }
}
export class LooseNote extends TLooseNoteBaseModel {
  constructor(values: Partial<TLooseNoteFields> = {}) { super(values); }
}
export class Open extends TOpenBaseModel {
  constructor(values: Partial<TOpenFields> = {}) { super(values); }
}
export class Shape extends TShapeBaseModel {
  constructor(values: Partial<TShapeFields> = {}) { super(values); }
}
