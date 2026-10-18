import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Checkout, TCheckout } from './checkout.model.js';
import type { TCheckoutJSON } from './checkout.model.generated.js';
import type { MoneyModel, MoneyFields, MoneyJSON } from './sdk/models/Money.js';

export type AliasSame = Assert<Same<WireFormat<TCheckout>, TCheckoutJSON>>;
export type ClassSame = Assert<Same<WireFormat<Checkout>, TCheckoutJSON>>;
export type AliasNotAny = Assert<NotAny<WireFormat<TCheckout>>>;
export type SdkModelSame = Assert<Same<WireFormat<MoneyModel>, MoneyJSON>>;
export type SdkFieldsSame = Assert<Same<WireFormat<MoneyFields>, MoneyJSON>>;
