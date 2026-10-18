import type { IObject } from '@exprtlabs/golem/model';
import type { TCustomer } from '../shared/customer.js';

// #region worker-model
// The worker declares its own IObject over the same shared plain type.
export type TWorkerCustomer = IObject<TCustomer>;
// #endregion worker-model
