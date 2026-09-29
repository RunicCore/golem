export class MoneyModel {
  public constructor() {}
}
// Generated companions import the SDK's per-model codec helpers alongside the model class.
export function stringifyfixture_money(value: MoneyModel): string {
  return JSON.stringify(value);
}
export function toWireFormatfixture_money(value: MoneyModel): object {
  return { ...value };
}
