import { builtinClassByOpenApiFormat, type BuiltinClass } from '@exprtlabs/golem/internal/emitter';
import { isJsonObject } from './json.js';
import type { OpenApiDates } from './model-resolution.js';

/** The built-in class that a string schema converts to under the `dates` value (a `date-time` string is a Date, or a Temporal.Instant); any other schema has none. */
export function dateClassOf(schema: unknown, dates: OpenApiDates): BuiltinClass | undefined {
  if (!isJsonObject(schema) || typeof schema.format !== 'string') return undefined;
  if (!(schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string')))) return undefined;
  return builtinClassByOpenApiFormat(dates, schema.format);
}
