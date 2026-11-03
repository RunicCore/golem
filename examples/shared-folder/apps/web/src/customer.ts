// #region web-class
import { TCustomerBaseModel } from './generated/models/shared/customer.model.generated.js';

// The web app extends the base class that its own models.output holds.
export class Customer extends TCustomerBaseModel {
  public label(): string {
    return `${this.name}, ${this.address.city}`;
  }
}
// #endregion web-class
