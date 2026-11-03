export let childCalls = 0;
export let lastChild: unknown;
export function reset(): void { childCalls = 0; lastChild = undefined; }
export function childPredicate(value: unknown): boolean {
  childCalls += 1;
  lastChild = value;
  return typeof value === "object" && value !== null && Reflect.get(Reflect.get(value, "savingState"), "dirty") === true;
}
