export let stringCalls = 0;
export let numberCalls = 0;
export function stringValue(value: unknown): boolean { stringCalls += 1; return typeof value === "string"; }
export function numberValue(value: unknown): boolean { numberCalls += 1; return typeof value === "number"; }