// #region split-model
import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem-openapi-ts/mobx';
import type { Integer, Minimum } from '@exprtlabs/golem/tags';
import { action } from 'mobx';
import { TSplitEditorBaseModel, type TSplitEditorInit } from './split-editor.model.generated.js';

// The number of instalments that a payment splits into.
export type TSplitEditor = IModel<{ parts: number & Integer & Minimum<1> }>;

export class SplitEditor extends TSplitEditorBaseModel {
  public constructor(values: TSplitEditorInit = {}) {
    super({ parts: 1, ...values });
    asGenObservable(this, { setParts: action });
  }

  public setParts(parts: number): void {
    this.parts = parts;
  }
}
// #endregion split-model
