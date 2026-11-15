/** The defaults of the three limits on loading references: the plan writes them into a job that sets none, and the loader applies them to a caller that sets none. */
export const REFERENCE_LIMIT_DEFAULTS = {
  maxRefBytes: 5 * 1024 * 1024,
  maxRefDocuments: 256,
  refTimeoutMs: 10_000,
} as const;
