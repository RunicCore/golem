import { computed, makeObservable, observable, runInAction } from 'mobx';
import { encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { getValidator } from '@exprtlabs/golem/validation';
import type { PaymentsClientPort } from '../sdk/index.js';
import { PaymentEditor } from './payment-editor.model.js';

export type SaveState = 'idle' | 'saving' | 'success' | 'error';

// The demo signs in one merchant; the editor edits the money and the note.
const merchant = { id: 'merchant-1', name: 'Book shop' };
const billing = { name: 'Accounts' };

const providerDown = 'The payment provider declined or is unavailable.';

function receipt(payment: { id: string; charge?: { id: string; status: string; settlesOn: string } }): string {
  const { charge } = payment;
  return `Payment ${payment.id} saved.${charge ? ` Charge ${charge.id} is ${charge.status}, settles ${charge.settlesOn}.` : ''}`;
}

export class PaymentStore {
  public readonly editor = new PaymentEditor();
  public saveState: SaveState = 'idle';
  public message = '';

  private readonly createPayment: ReturnType<PaymentsClientPort['createPayment']>;
  private activeController: AbortController | undefined;
  private disposed = false;

  public constructor(client: PaymentsClientPort) {
    this.createPayment = client.createPayment();
    makeObservable(this, { saveState: observable, message: observable, sending: computed });
  }

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
      const wire = encodeGeneratedModel(this.editor);
      const response = await this.createPayment.execute(
        { body: { merchant, billing, money: wire.money, note: wire.note } },
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
