import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { Money } from './sdk/types.js';
import { TWalletBaseModel } from './wallet.model.generated.js';
export type TWallet = IModel<{ money: Money | string; tagged: (Money | { kind: 'other'; value: number }) & Discriminator<'kind', Money> }>;
export class Wallet extends TWalletBaseModel {}
