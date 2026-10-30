import 'temporal-polyfill/global';
import type { IModel } from '@exprtlabs/golem/model';
import type { Charge } from './sdk/index.js';
import { TChargeRecordBaseModel, TChargeViewBaseModel, type TChargeViewInit } from './charge-record.model.generated.js';

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

// #region charge-view
export type TChargeView = IModel<Charge>; // A model over the type itself: its fields are the fields of Charge.

export class ChargeView extends TChargeViewBaseModel {
  public readonly fetchedAt: Temporal.Instant; // App state: not a field of Charge, so it is never sent or checked.

  public constructor(values: TChargeViewInit, fetchedAt = Temporal.Now.instant()) {
    super(values); // Assigns the fields of Charge first.
    this.fetchedAt = fetchedAt;
  }
}
// #endregion charge-view
