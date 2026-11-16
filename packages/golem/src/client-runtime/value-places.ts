import { assertNever } from '../assert-never.js';

/**
 * Where a value sits in an operation, after the operation name: a request body by content type, a response body or stream item by status and content type,
 * a parameter by location (`path`, `query`, `header`, `cookie` or `querystring`) and name, a response header by status and name.
 * The writers of the SDK codecs and the validators name a value by its place and the client reads it by the key of its place (`placeKey`), so this module
 * is the one place that knows the key format. It sits in the runtime project because the client reads the keys, and the build tooling imports it from here.
 */
export type ValuePlace =
  | readonly ['request', contentType: string]
  | readonly ['response', status: string, contentType: string]
  | readonly ['parameter', location: string, name: string]
  | readonly ['response-header', status: string, name: string];

export type ValuePlaceKind = ValuePlace[0];

/** The number of parts of each kind of place, the kind included. */
const PLACE_LENGTH: Readonly<Record<ValuePlaceKind, number>> = { request: 2, response: 3, parameter: 3, 'response-header': 3 };

function isPlaceKind(value: unknown): value is ValuePlaceKind {
  return typeof value === 'string' && Object.hasOwn(PLACE_LENGTH, value);
}

/** Whether the parts name a place: a known kind with the parts that kind has, each a string. */
export function isValuePlace(parts: readonly unknown[]): parts is ValuePlace {
  const [kind] = parts;
  return isPlaceKind(kind) && parts.length === PLACE_LENGTH[kind] && parts.every((part) => typeof part === 'string');
}

/** The key of a response body, stream item or header in the tables of an operation: the status and then the content type or the header name. A response status is a number at run time. */
export function statusKey(status: number | string, name: string): string {
  return `${status}:${name}`;
}

/** The key of a parameter in the `parameters` table of an operation. */
function parameterKey(location: string, name: string): string {
  return `${location}:${name}`;
}

/** The location and the name of a key that `parameterKey` wrote (a name may hold `:`, a location does not). */
export function parameterOfKey(key: string): { readonly location: string; readonly name: string } {
  const separator = key.indexOf(':');
  return { location: key.slice(0, separator), name: key.slice(separator + 1) };
}

/** The key of the value at a place in the table of its kind: the codecs `encode`, `decode`, `parameters` and `headers` of an operation and its validators `responses` and `responseHeaders`. */
export function placeKey(place: ValuePlace): string {
  switch (place[0]) {
    case 'request': return place[1];
    case 'response':
    case 'response-header': return statusKey(place[1], place[2]);
    case 'parameter': return parameterKey(place[1], place[2]);
    default: return assertNever(place);
  }
}

/** The key of an operation's value in the tables of the generators (`OpenApiModelAnalysis.convertedNodeIds`, the `valueNodes` of a manifest): a JSON array of strings, the operation name and then the place. `parseValueKey` reads it back. */
export function valueKey(operation: string, at: ValuePlace): string {
  return JSON.stringify([operation, ...at]);
}

/** The operation name and the place of a key that `valueKey` wrote; `undefined` for any other text. */
export function parseValueKey(key: string): { readonly operation: string; readonly at: ValuePlace } | undefined {
  const parts: unknown = JSON.parse(key);
  if (!Array.isArray(parts)) return undefined;
  const [operation, ...at] = parts;
  return typeof operation === 'string' && isValuePlace(at) ? { operation, at } : undefined;
}
