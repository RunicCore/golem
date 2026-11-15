/** The defaults of the three limits on loading references: the plan writes them into a job that sets none, and the loader applies them to a caller that sets none. */
export const REFERENCE_LIMIT_DEFAULTS = {
  maxRefBytes: 5 * 1024 * 1024,
  maxRefDocuments: 256,
  refTimeoutMs: 10_000,
} as const;

export const OPENAPI_DATES = ['date', 'temporal'] as const;

/** The one place that checks an option that holds one of a closed set of words, for a job of `golem.yaml` and for a caller of the generator: the value of the set, `undefined` when it is not set, and a `TypeError` that names `where` for any other value. */
export function optionChoice<Choice extends string>(value: unknown, allowed: readonly Choice[], where: string): Choice | undefined {
  if (value === undefined) return undefined;
  const choice = allowed.find((item) => item === value);
  if (choice === undefined) throw new TypeError(`${where} must be ${allowed.map((item) => JSON.stringify(item)).join(' or ')} when provided`);
  return choice;
}
