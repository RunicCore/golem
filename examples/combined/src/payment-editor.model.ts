// #region model-declaration
import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from '../sdk/index.js';

export type TPaymentEditor = IModel<{
  money: Money;
  note: string;
}>;
// #endregion model-declaration

import { getValidator } from '@exprtlabs/golem/validation';
import { PaymentEditorBaseModel, type PaymentEditorInit } from './payment-editor.model.generated.js';

export class PaymentEditor extends PaymentEditorBaseModel {
  public constructor(values: PaymentEditorInit = {}) {
    super(values);
    getValidator(this).extend({
      note: value => value.length <= 100 || 'Keep the note within 100 characters',
    });
  }

  // #region model-methods
  public get summary(): string {
    return `${this.money.amount} ${this.money.currency}: ${this.note}`;
  }

  public setAmount(amount: number): void {
    this.money.amount = amount;
  }
  // #endregion model-methods
}
