/**
 * The Temporal class that `dates: temporal` reads for each string format, by the name that follows `Temporal.`: format
 * `date-time` reads `Temporal.Instant`, and so on. The OpenAPI model resolver derives its types from this table, and the
 * validator compiler keeps the same formats at the sanity level.
 */
export const TEMPORAL_FORMAT_CLASSES = { 'date-time': 'Instant', date: 'PlainDate', duration: 'Duration' } as const;

/**
 * The string formats that a golem converter decodes: `Date` reads `date-time`, and `dates: temporal` reads each format of
 * `TEMPORAL_FORMAT_CLASSES`. The schema has no mark for a field that converts, and a parser is more lenient than its
 * format (`Temporal.PlainDate.from('20250102')`, `Temporal.Duration.from('p1d')`), so the sanity level keeps these
 * formats: a bad text answers a validation issue, which names the field, and not a conversion error.
 */
export const CONVERTED_FORMATS: ReadonlySet<string> = new Set(['date-time', ...Object.keys(TEMPORAL_FORMAT_CLASSES)]);
