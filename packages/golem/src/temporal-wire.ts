/**
 * The wire patterns of the Temporal types that have no JSON Schema format. `temporal.ts` states them in its wire types and checks them in its codecs,
 * and the built-in class registry of the build tools (`tooling/builtin-classes.ts`) states them in the wire schema of a plain global Temporal field.
 */
export const ZONED_DATE_TIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})\\[[A-Za-z0-9_+\\-/:]+\\]$';
export const PLAIN_DATE_TIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?$';
export const PLAIN_TIME_PATTERN = '^\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?$';
export const DURATION_PATTERN = '^-?P(?!$)(?:\\d+Y)?(?:\\d+M)?(?:\\d+W)?(?:\\d+D)?(?:T(?=\\d)(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d{1,9})?S)?)?$';
