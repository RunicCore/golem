export let firstCalls = 0;
export let secondCalls = 0;
export function first(value: unknown): boolean { firstCalls += 1; return typeof value === "string"; }
export function second(value: unknown): boolean { secondCalls += 1; return value !== ""; }
export const firstAlias = first;