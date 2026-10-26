import 'temporal-polyfill/global';
import type { IModel } from '@exprtlabs/golem/model';
import type { Charge } from './sdk/index.js';
import { TChargeRecordBaseModel } from './charge-record.model.generated.js';

// #region charge-record-declaration
export type TChargeRecord = IModel<{ charge: Charge }>;
// #endregion charge-record-declaration

// #region charge-record-class
export class ChargeRecord extends TChargeRecordBaseModel {
  public isOverdue(today: Temporal.PlainDate): boolean {
    return Temporal.PlainDate.compare(this.charge.settlesOn, today) < 0; // The settlement day itself is not overdue.
  }
}
// #endregion charge-record-class
