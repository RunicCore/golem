/**
 * The end of a switch over a kind: `default: return assertNever(value)`. A switch that lists every kind leaves `never` here, so a
 * kind added later is a compile error at each switch that does not handle it. A value that reaches this at run time is a fault of
 * golem's own code, so it throws.
 */
export function assertNever(value: never): never {
  throw new Error(`Internal error: unhandled case ${JSON.stringify(value)}`);
}
