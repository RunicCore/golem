// Runs inside a generated SDK: an allOf variant inherits a date-time field from
// its base, and the discriminated union selects the variant.
import { decodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import * as models from './dist/index.js';

const { fromWireFormatPayment, fromWireFormatCardPayment, fromWireFormatPaymentBase, parsePayment, parseCardPayment,
  validatePayment, validateCardPayment, CardPaymentModel } = models;
const base = { id: 'p1', createdAt: '2026-01-01T00:00:00.000Z' };
const card = { ...base, kind: 'card', maskedPan: '1234' };
const isDate = (value) => value instanceof Date && value.toISOString() === base.createdAt;
const report = {
  base: isDate(fromWireFormatPaymentBase(base).createdAt),
  variant: isDate(fromWireFormatCardPayment(card).createdAt),
  union: isDate(fromWireFormatPayment(card).createdAt),
  parseVariant: isDate(parseCardPayment(JSON.stringify(card)).createdAt),
  parseUnion: isDate(parsePayment(JSON.stringify(card)).createdAt),
  unionConstructs: fromWireFormatPayment(card, { construct: CardPaymentModel }) instanceof CardPaymentModel,
  validateVariant: validateCardPayment(fromWireFormatCardPayment(card)),
  validateUnion: validatePayment(fromWireFormatPayment(card)),
  nonObjectIsInput: (() => {
    try { decodeGeneratedModel(CardPaymentModel, 'text'); return false; }
    catch (error) { return error?.kind === 'deserialization' && error.causedByInput === true; }
  })(),
  rejectsBadDate: (() => { try { fromWireFormatPayment({ ...card, createdAt: 'nope' }); return false; } catch { return true; } })(),
};
process.stdout.write(JSON.stringify(report));
