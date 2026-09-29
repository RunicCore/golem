import { registerGeneratedModel } from "@exprtlabs/codegen/model";
import { createOpenApiSyncAjvEngine } from "@exprtlabs/codegen/ajv";
import { ajvIssues, createObjectCodec, registerIModelClass, requireAjvSchema, resolveGeneratedModelSchemaRefs, serdeFailFast, validationFailure, IssueRepresentation } from "@exprtlabs/codegen/serde";
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
const objectAjvFast = createOpenApiSyncAjvEngine({ allErrors: false, validationBindings: {} });
const objectAjvAll = createOpenApiSyncAjvEngine({ allErrors: true, validationBindings: {} });
const moneySchema = resolveGeneratedModelSchemaRefs({ $id: "Money", type: "object", required: ["currency", "amount"], additionalProperties: false, properties: { currency: { type: "string" }, amount: { type: "number" } } });
objectAjvFast.addSchema(moneySchema, "Money");
objectAjvAll.addSchema(moneySchema, "Money");
const validateMoneyFast = requireAjvSchema(objectAjvFast.getSchema("Money"), "Money");
const validateMoneyAll = requireAjvSchema(objectAjvAll.getSchema("Money"), "Money");
function validateMoney(value: unknown, options?: { readonly failFast?: boolean }) { const validator = serdeFailFast(options) ? validateMoneyFast : validateMoneyAll; const ok = validator(value) === true; (validateMoney as { errors?: unknown }).errors = validator.errors; return ok; }
createObjectCodec("Money", { stringify() { throw new Error("unused"); }, parse() { throw new Error("unused"); }, validate: validateMoney, assert(value) { if (validateMoneyFast(value) !== true) validationFailure(ajvIssues(validateMoneyFast, value, IssueRepresentation.Model)); return value; }, toWireFormat: encodeMoney, fromWireFormat: decodeMoney, schema: moneySchema });