export class MoneyModel {
  public currency = 'USD';
  public constructor(values: { currency?: string } = {}) {
    if (values.currency !== undefined) this.currency = values.currency;
  }
  public static fromJSON(_value: unknown): MoneyModel { return new MoneyModel(); }
  public toJSON(): { currency: string } { return { currency: this.currency }; }
}
// Generated companions import the SDK's per-model serde helpers alongside the model class.
export function stringifyfixture_money(value: MoneyModel, _options?: { readonly validate?: boolean }): string {
  return JSON.stringify(value.toJSON());
}
export function toWireFormatfixture_money(value: MoneyModel, _options?: { readonly validate?: boolean }): { currency: string } {
  return value.toJSON();
}
