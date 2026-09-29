
import { asGenObservable } from '@exprtlabs/codegen/mobx';
import { observable } from 'mobx';
import { CardPaymentModel, EnvelopeModel } from './index.js';
import type { Envelope } from './types.js';

export class TrackedEnvelope extends EnvelopeModel {
  edits = 0;
  constructor(values: Partial<Envelope> = {}) {
    super(values);
    this.edits = 0;
    asGenObservable(this, {
      edits: observable,
    });
  }
}

export class TrackedCard extends CardPaymentModel {
  edits = 0;
  constructor() {
    super({ amount: 1, kind: 'card', last4: '4242' });
    asGenObservable(this, { edits: observable });
  }
}
