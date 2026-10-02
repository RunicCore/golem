import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/index.js';
import { TWalletBaseModel } from './wallet.model.generated.js';

export type TWallet = IModel<{ coins: Money[] }>;
export class Wallet extends TWalletBaseModel {}
