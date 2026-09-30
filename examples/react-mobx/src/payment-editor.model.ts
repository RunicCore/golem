import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem/mobx';
import { getValidator } from '@exprtlabs/golem/validation';
import { action, computed, observable } from 'mobx';
import type { Money } from '../sdk/index.js';
import { PaymentEditorBase, type PaymentEditorInit } from './payment-editor.model.generated.js';

export type TPaymentEditor = IModel<{ money: Money; note: string }>;
export type { PaymentEditorFields, PaymentEditorInit } from './payment-editor.model.generated.js';

export class PaymentEditor extends PaymentEditorBase {
  public edits = 0;

  public constructor(values: PaymentEditorInit = {}) {
    super({ money: { amount: 0, currency: 'USD' }, note: '', ...values });
    asGenObservable(this, {
      edits: observable,
      summary: computed,
      setAmount: action,
      setCurrency: action,
      setNote: action,
    });
    getValidator(this).extend({
      note: value => value.length <= 100 || 'Keep the note within 100 characters',
    });
  }

  public get summary(): string {
    const amount = Number.isFinite(this.money.amount) ? this.money.amount : '—';
    return `${amount} ${this.money.currency}${this.note ? `: ${this.note}` : ''}`;
  }

  public setAmount(amount: number): void {
    this.money.amount = amount;
    this.edits += 1;
  }

  public setCurrency(currency: string): void {
    this.money.currency = currency.toUpperCase();
    this.edits += 1;
  }

  public setNote(note: string): void {
    this.note = note;
    this.edits += 1;
  }
}
