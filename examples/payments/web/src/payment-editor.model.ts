// #region model-definition
// #region model-declaration
import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import { getValidator } from '@exprtlabs/golem/validation';
import { action, computed } from 'mobx';
import type { TMoney } from '../sdk/index.js';
import { TPaymentEditorBaseModel, type TPaymentEditorInit } from './payment-editor.model.generated.js';

export type TPaymentEditor = IModel<{ money: TMoney; note: string }>;
// #endregion model-declaration

export class PaymentEditor extends TPaymentEditorBaseModel {
  public constructor(values: TPaymentEditorInit = {}) {
    super({ money: { amount: '0.00', currency: 'USD' }, note: '', ...values });
    asGenObservable(this, { summary: computed, setAmount: action, setCurrency: action, setNote: action });
    getValidator(this).extend({ note: value => value.length <= 140 || 'Keep the note within 140 characters' });
    // Readable messages for the generated pattern checks of the nested money object.
    getValidator(this).messages([
      { path: ['money', 'amount'], code: 'pattern', message: 'Enter an amount like 12.50' },
      { path: ['money', 'currency'], code: 'pattern', message: 'Use a three-letter currency code like USD' },
    ]);
  }

  // #region model-methods
  public get summary(): string {
    return `${this.money.amount} ${this.money.currency}${this.note ? `: ${this.note}` : ''}`;
  }

  // #region nested-editing
  public setAmount(amount: string): void {
    this.money.amount = amount; // The nested money model is observable too.
  }
  // #endregion nested-editing

  public setCurrency(currency: string): void {
    this.money.currency = currency.toUpperCase();
  }

  public setNote(note: string): void {
    this.note = note;
  }
  // #endregion model-methods
}
// #endregion model-definition
