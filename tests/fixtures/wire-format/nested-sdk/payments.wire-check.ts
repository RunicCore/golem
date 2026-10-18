import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { MerchantFields, MerchantJSON, MerchantModel } from './sdk/models/Merchant.js';
import type { MerchantOmitIdFields, MerchantOmitIdJSON, MerchantOmitIdModel } from './sdk/models/MerchantOmitId.js';
import type { PaymentFields, PaymentJSON, PaymentModel } from './sdk/models/Payment.js';

export type MerchantModelSame = Assert<Same<WireFormat<MerchantModel>, MerchantJSON>>;
export type MerchantFieldsSame = Assert<Same<WireFormat<MerchantFields>, MerchantJSON>>;
export type MerchantOmitIdModelSame = Assert<Same<WireFormat<MerchantOmitIdModel>, MerchantOmitIdJSON>>;
export type MerchantOmitIdFieldsSame = Assert<Same<WireFormat<MerchantOmitIdFields>, MerchantOmitIdJSON>>;
export type PaymentModelSame = Assert<Same<WireFormat<PaymentModel>, PaymentJSON>>;
export type PaymentFieldsSame = Assert<Same<WireFormat<PaymentFields>, PaymentJSON>>;
export type PaymentNotAny = Assert<NotAny<WireFormat<PaymentModel>>>;
