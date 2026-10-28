import { registerGeneratedModel } from "@exprtlabs/golem/model";
import { createObjectCodec, registerIModelClass } from "@exprtlabs/golem/serde";
export class MoneyModel {
  public currency = "USD";
  public amount = 0;
  public constructor(values: { currency?: string; amount?: number } = {}) { if (values.currency !== undefined) this.currency = values.currency; if (values.amount !== undefined) this.amount = values.amount; }
}
export function stringifyfixture_money(value: object, _options?: object): string { return JSON.stringify(value); }
export function toWireFormatfixture_money(value: unknown, _options?: object): unknown { return value; }
function decodeMoney(value: unknown) { const data = value as { currency?: unknown; amount?: unknown }; return new MoneyModel({ currency: typeof data.currency === "string" ? data.currency : undefined, amount: typeof data.amount === "number" ? data.amount : undefined }); }
function encodeMoney(model: MoneyModel) { return { currency: model.currency, amount: model.amount }; }
registerGeneratedModel(MoneyModel, {
  fields: ["currency", "amount"],
  profile: { validation: true },
  conversion: { decode: decodeMoney, encode: encodeMoney },
  codecId: "Money",
});
registerIModelClass("Money", MoneyModel);
function validateMoney(value: unknown) { const data = value as { currency?: unknown; amount?: unknown } | null; return typeof data === "object" && data !== null && typeof data.currency === "string" && typeof data.amount === "number"; }
createObjectCodec("Money", { stringify() { throw new Error("unused"); }, parse() { throw new Error("unused"); }, validate: validateMoney, assert(value) { return value; }, toWireFormat: encodeMoney, fromWireFormat: decodeMoney });
