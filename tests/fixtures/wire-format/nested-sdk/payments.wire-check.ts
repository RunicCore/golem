import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Merchant, MerchantOmitId, Payment } from './sdk/index.js';

// The SDK type is the converted type: paidAt is a Date, and its wire form is the ISO string.
export type PaymentConverted = Assert<Same<Payment['paidAt'], Date>>;
export type MerchantSame = Assert<Same<WireFormat<Merchant>, Merchant>>;
export type MerchantOmitIdSame = Assert<Same<WireFormat<MerchantOmitId>, MerchantOmitId>>;
export type PaymentWire = Assert<Same<WireFormat<Payment>, { id: string; merchant: Merchant; billing: MerchantOmitId; paidAt: string; note?: string }>>;
export type PaymentNotAny = Assert<NotAny<WireFormat<Payment>>>;
