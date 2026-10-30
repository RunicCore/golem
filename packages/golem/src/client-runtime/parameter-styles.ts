/**
 * The one table of OpenAPI 3.1 and 3.2 parameter styles. The client writes a parameter from it (`parameters.ts`), and the generator checks the style of a parameter against it.
 */

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/** The characters that separate the items or the members in the text of a parameter. */
type ParameterSeparator = ',' | ' ' | '|' | '.' | ';';

export interface ParameterStyleRule {
  /** The explode value the style takes when the parameter names none. */
  readonly explode: boolean;
  /** The prefix of the text: `.` (label) or `;name=` (matrix). */
  readonly prefix?: 'label' | 'matrix';
  /** An array: its items joined by `separator` in one text, or each item written on its own (a repeated key, a repeated `;name=`). */
  readonly array: { readonly layout: 'joined'; readonly separator: ParameterSeparator } | { readonly layout: 'repeated' };
  /**
   * An object: `flat` is `k,v,k,v` and `keyed` is `k=v,k=v`, joined by `separator` in one text; `keys` writes each member as a key of its own,
   * and `deep` as the key `name[member]`.
   */
  readonly object: { readonly layout: 'flat' | 'keyed'; readonly separator: ParameterSeparator } | { readonly layout: 'keys' } | { readonly layout: 'deep' };
}

const DEFAULT_STYLE: Readonly<Record<ParameterLocation, string>> = { path: 'simple', query: 'form', header: 'simple', cookie: 'form' };

/** The members of an object in `explode` form: `k=v` joined by `separator`, or `k,v` pairs joined by a comma. */
const members = (explode: boolean, separator: ParameterSeparator): ParameterStyleRule['object'] =>
  explode ? { layout: 'keyed', separator } : { layout: 'flat', separator: ',' };

/** The rule of `style` for a parameter in `location`; undefined when the location has no such style. `style` is the default of the location when it is undefined. */
export function parameterStyleRule(location: ParameterLocation, style: string | undefined, explode?: boolean): ParameterStyleRule | undefined {
  const name = style ?? DEFAULT_STYLE[location];
  if (location === 'header' || (location === 'path' && name === 'simple')) {
    if (name !== 'simple') return undefined;
    const exploded = explode ?? false;
    return { explode: exploded, array: { layout: 'joined', separator: ',' }, object: members(exploded, ',') };
  }
  if (location === 'path') {
    const exploded = explode ?? false;
    if (name === 'label') return { explode: exploded, prefix: 'label', array: { layout: 'joined', separator: exploded ? '.' : ',' }, object: members(exploded, '.') };
    if (name === 'matrix') return { explode: exploded, prefix: 'matrix', array: exploded ? { layout: 'repeated' } : { layout: 'joined', separator: ',' }, object: members(exploded, ';') };
    return undefined;
  }
  if (location === 'cookie') {
    if (name !== 'form' && name !== 'cookie') return undefined;
    const exploded = explode ?? true;
    return { explode: exploded, array: exploded ? { layout: 'repeated' } : { layout: 'joined', separator: ',' }, object: exploded ? { layout: 'keys' } : { layout: 'flat', separator: ',' } };
  }
  // Query: space and pipe delimited text is always joined, whatever `explode` says.
  if (name === 'form') {
    const exploded = explode ?? true;
    return { explode: exploded, array: exploded ? { layout: 'repeated' } : { layout: 'joined', separator: ',' }, object: exploded ? { layout: 'keys' } : { layout: 'flat', separator: ',' } };
  }
  if (name === 'spaceDelimited' || name === 'pipeDelimited') {
    const separator = name === 'spaceDelimited' ? ' ' : '|';
    return { explode: explode ?? false, array: { layout: 'joined', separator }, object: { layout: 'flat', separator } };
  }
  if (name === 'deepObject') return { explode: explode ?? true, array: { layout: 'joined', separator: ',' }, object: { layout: 'deep' } };
  return undefined;
}
