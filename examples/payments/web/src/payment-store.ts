import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { toWireFormat } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import type { PaymentsClientPort } from '../sdk/index.js';
import { PaymentEditor, type TPaymentEditor } from './payment-editor.model.js';
import { SplitEditor } from './split-editor.model.js';

export type SaveState = 'idle' | 'saving' | 'success' | 'error';

// The merchant is fixed for the demo; the editor edits the money and the note.
const merchant = { id: 'merchant-1', name: 'Book shop' };
const billing = { name: 'Accounts' };

const providerDown = 'The payment provider declined or is unavailable.';

function receipt(payment: { id: string; charge?: { id: string; status: string; settlesOn: string } }): string {
  const { charge } = payment;
  return `Payment ${payment.id} saved.${charge ? ` Charge ${charge.id} is ${charge.status}, settles ${charge.settlesOn}.` : ''}`;
}

// #region draft-conversion
// Converts the text of the input to a number. A half-typed `3.`, an empty text or 0 does not convert.
function toParts(draft: string): number | undefined {
  const parts = /^[0-9]+$/.test(draft) ? Number(draft) : NaN;
  return Number.isSafeInteger(parts) && parts >= 1 ? parts : undefined; // The model field has Minimum<1>.
}
// #endregion draft-conversion

export class PaymentStore {
  public readonly editor = new PaymentEditor();
  public readonly split = new SplitEditor();
  public saveState: SaveState = 'idle';
  public message = '';
  public partsDraft = String(this.split.parts); // The text in the input. The model keeps the number.

  private readonly createPayment: ReturnType<PaymentsClientPort['createPayment']>;
  private activeController: AbortController | undefined;
  private disposed = false;

  public constructor(client: PaymentsClientPort) {
    this.createPayment = client.createPayment();
    makeObservable(this, {
      saveState: observable,
      message: observable,
      sending: computed,
      partsDraft: observable,
      partsDraftError: computed,
      setPartsDraft: action,
    });
  }

  // #region draft-number
  public setPartsDraft(draft: string): void {
    this.partsDraft = draft; // The input always shows the draft.
    const parts = toParts(draft);
    if (parts !== undefined) this.split.setParts(parts); // Only a draft that converts reaches the model.
  }

  public get partsDraftError(): string | undefined {
    return toParts(this.partsDraft) === undefined ? 'Enter a whole number like 3' : undefined;
  }
  // #endregion draft-number

  // #region loading
  public get sending(): boolean {
    return this.createPayment.loading; // True from execute until the response settles.
  }
  // #endregion loading

  public async save(): Promise<boolean> {
    if (this.disposed || this.saveState === 'saving') return false;
    const controller = new AbortController();
    this.activeController = controller;
    runInAction(() => { this.saveState = 'saving'; this.message = ''; });
    try {
      // #region validate-and-save
      const valid = await getValidator(this.editor).validate({ failFast: false });
      if (!valid) {
        runInAction(() => { this.saveState = 'idle'; });
        return false;
      }
      // #endregion validate-and-save
      // #region send-payment
      const wire = toWireFormat<TPaymentEditor>(this.editor, { validate: false });
      const response = await this.createPayment.execute(
        { body: { merchant, billing, money: this.editor.money, note: wire.note } },
        { signal: controller.signal },
      );
      // #endregion send-payment
      if (this.disposed) return false;
      const saved = response.status === 201;
      runInAction(() => {
        this.saveState = saved ? 'success' : 'error';
        this.message = saved ? receipt(response.body) : response.status === 502 ? providerDown : 'The API rejected the payment.';
      });
      return saved;
    } catch (error: unknown) {
      if (this.disposed || controller.signal.aborted) return false;
      runInAction(() => {
        this.saveState = 'error';
        this.message = `Could not save the payment: ${error instanceof Error ? error.message : 'the API is unreachable.'}`;
      });
      return false;
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.activeController?.abort();
  }
}
