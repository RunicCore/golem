import { computed, makeObservable, observable, runInAction } from 'mobx';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { getValidator } from '@exprtlabs/codegen/validation';
import {
  MoneyModel,
  PaymentsClient,
  type PaymentsClientPort,
} from '../sdk/index.js';
import { PaymentEditor, type PaymentEditorInit } from './payment-editor.model.js';

export type SaveState = 'idle' | 'saving' | 'success' | 'error';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The demo server could not be reached.';
}

export class PaymentStore {
  public readonly editor: PaymentEditor;
  public saveState: SaveState = 'idle';
  public message = '';
  public lastSaved: MoneyModel | undefined;

  private readonly client: PaymentsClientPort;
  private activeController: AbortController | undefined;
  private disposed = false;

  public constructor(
    client: PaymentsClientPort,
    values: PaymentEditorInit = {},
  ) {
    this.client = client;
    this.editor = new PaymentEditor(values);
    makeObservable(this, {
      saveState: observable,
      message: observable,
      lastSaved: observable.ref,
      saving: computed,
    });
  }

  public get saving(): boolean {
    return this.saveState === 'saving';
  }

  public async save(): Promise<boolean> {
    if (this.disposed || this.saving) return false;

    const controller = new AbortController();
    this.activeController = controller;
    runInAction(() => {
      this.saveState = 'saving';
      this.message = '';
    });

    try {
      const valid = await getValidator(this.editor).validate({ failFast: false });
      if (!valid) {
        runInAction(() => {
          if (!this.disposed && this.activeController === controller) this.saveState = 'idle';
        });
        return false;
      }
      if (this.disposed || controller.signal.aborted || this.activeController !== controller) {
        return false;
      }

      const wire = encodeGeneratedModel(this.editor);
      const response = await this.client.createPayment().execute(
        { body: wire.money },
        { signal: controller.signal },
      );
      if (this.disposed || controller.signal.aborted || this.activeController !== controller) {
        return false;
      }

      const saved = decodeGeneratedModel(MoneyModel, response.body);
      if (this.disposed || controller.signal.aborted || this.activeController !== controller) {
        return false;
      }
      runInAction(() => {
        this.lastSaved = saved;
        this.saveState = 'success';
        this.message = 'Payment saved by the local demo server.';
      });
      return true;
    } catch (error: unknown) {
      if (isAbortError(error) || this.disposed || controller.signal.aborted) {
        runInAction(() => {
          if (!this.disposed && this.activeController === controller) this.saveState = 'idle';
        });
        return false;
      }

      runInAction(() => {
        if (this.activeController === controller) {
          this.saveState = 'error';
          this.message = `Could not save the payment: ${errorMessage(error)}`;
        }
      });
      return false;
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.activeController?.abort();
    this.activeController = undefined;
    runInAction(() => {
      this.saveState = 'idle';
      this.message = '';
    });
  }
}

// #region create-client
export function createPaymentStore(baseUrl: string): PaymentStore {
  return new PaymentStore(new PaymentsClient({ baseUrl }));
}
// #endregion create-client
