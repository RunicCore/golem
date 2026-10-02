import type { TPayment } from './payment.model.js';
export const handlers = {
  load(): TPayment { return { id: '1', note: '' }; },
};
export abstract class Source {
  abstract fetch(): TPayment;
  find(id: string): TPayment;
  find(id: string | number): TPayment { return { id: String(id), note: '' }; }
}
