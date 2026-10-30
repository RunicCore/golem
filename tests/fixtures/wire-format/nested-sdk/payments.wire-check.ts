import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Merchant, MerchantOmitId, Payment } from './sdk/index.js';

export type MerchantSame = Assert<Same<WireFormat<Merchant>, Merchant>>;
export type MerchantOmitIdSame = Assert<Same<WireFormat<MerchantOmitId>, MerchantOmitId>>;
export type PaymentSame = Assert<Same<WireFormat<Payment>, Payment>>;
export type PaymentNotAny = Assert<NotAny<WireFormat<Payment>>>;
