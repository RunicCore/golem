// #region model-definition
import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import { getValidator } from '@exprtlabs/golem/validation';
import { action, computed } from 'mobx';
import type { Money } from '../sdk/index.js';
import { PaymentEditorBase, type PaymentEditorInit } from './payment-editor.model.generated.js';

export type TPaymentEditor = IModel<{ money: Money; note: string }>;

export class PaymentEditor extends PaymentEditorBase {
  public constructor(values: PaymentEditorInit = {}) {
    super({ money: { amount: 0, currency: 'USD' }, note: '', ...values });
    asGenObservable(this, { summary: computed, setNote: action, setAmount: action });
    getValidator(this).extend({ note: value => value.length <= 100 || 'Keep the note within 100 characters' });
  }

  public get summary(): string {
    return `${this.money.amount} ${this.money.currency}: ${this.note}`;
  }

  public setNote(note: string): void {
    this.note = note;
  }

  public setAmount(amount: number): void {
    this.money.amount = amount;
  }
}
// #endregion model-definition
