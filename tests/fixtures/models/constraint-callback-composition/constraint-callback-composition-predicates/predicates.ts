export let positiveCalls = 0;
export let nestedPositiveCalls = 0;
export let nonEmptyCalls = 0;
export function reset(): void { positiveCalls = 0; nestedPositiveCalls = 0; nonEmptyCalls = 0; }
export function positive(value: unknown): boolean {
  positiveCalls += 1;
  return typeof value === "number" && value > 0;
}
export function nestedPositive(value: unknown): boolean {
  nestedPositiveCalls += 1;
  return typeof value === "number" && value > 0;
}
export function nonEmpty(value: unknown): boolean {
  nonEmptyCalls += 1;
  return typeof value === "string" && value.length > 0;
}
