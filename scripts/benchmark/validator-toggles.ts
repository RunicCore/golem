/**
 * Scratch validators for the five typia comparison models, written the way the planned fast check (design
 * `validator-speed-design`, section 5) writes them, with one cost switched on or off at a time. They are hand-made
 * JavaScript, not golem output, so no toggle needs product code. Each row of a toggle run names what it changed.
 *
 * A toggle that is not here needs the fast check to exist first: the per-item call and the union tag read are written
 * inline by the generator below, and the real hop chain (codec, generated `validate`, `isValidModelValue`,
 * `runModelValidator`) is only approximated by `hops` forwarding closures.
 */

/** How unknown keys are found. F1 and F2 are exact under the JSON-view rule; `count` and `none` are not. */
export type KeyTest =
  | 'F1'     // loop over Object.keys, a switch captures declared values, an undefined unknown key is allowed
  | 'F2'     // present declared keys counted by own-enumerable test; F1 only when Object.keys(v).length differs
  | 'count'  // straight reads, Object.keys(v).length equals the declared count (unsound: skips optional and undefined keys)
  | 'none';  // straight reads, no unknown-key test (typia `is`)
export type FiniteTest = 'sub' | 'isFinite' | 'off';

export interface Toggles {
  readonly keyTest: KeyTest;
  /** `sub` is `x - x === 0`; `isFinite` is `Number.isFinite(x)`; `off` is `typeof x === 'number'` alone. */
  readonly finite: FiniteTest;
  /** `valid` adds `t - t === 0` for a Date; `off` is `instanceof Date` alone. */
  readonly date: 'valid' | 'off';
  /**
   * Forwarding closures between the caller and the validator, each with the codec call's signature. They share one code
   * body across every scratch validator, as the codec wrappers do across codecs, so in a run with many models the
   * call is megamorphic; the cost grows with the number of validators in the process.
   */
  readonly hops: number;
}

export const BASE_TOGGLES: Toggles = { keyTest: 'F1', finite: 'sub', date: 'valid', hops: 0 };

type Shape =
  | 'number' | 'string' | 'boolean' | 'date'
  | { readonly literal: string }
  | { readonly object: Fields }
  | { readonly array: Shape }
  | { readonly tuple: readonly Shape[] }
  | { readonly union: string; readonly members: readonly Fields[] };
type Fields = Readonly<Record<string, Shape>>;

const address: Fields = { street: 'string', city: 'string', zip: 'string', lat: 'number', lng: 'number' };
const item: Fields = { id: 'number', sku: 'string', name: 'string', price: 'number', quantity: 'number', createdAt: 'date' };

const MODELS: Readonly<Record<string, Fields>> = {
  flat: { id: 'number', name: 'string', email: 'string', age: 'number', score: 'number', active: 'boolean', createdAt: 'date' },
  nested: {
    id: 'number',
    owner: { object: { name: 'string', email: 'string', address: { object: address } } },
    billing: { object: address },
    shipping: { object: address },
    createdAt: 'date',
  },
  union: {
    id: 'number',
    shape: {
      union: 'kind',
      members: [
        { kind: { literal: 'circle' }, radius: 'number', at: 'date' },
        { kind: { literal: 'rect' }, width: 'number', height: 'number', at: 'date' },
        { kind: { literal: 'label' }, text: 'string', at: 'date' },
      ],
    },
  },
  array: { id: 'number', items: { array: { object: item } } },
  tuple: { id: 'number', row: { tuple: ['number', 'string', 'boolean', 'date'] }, range: { tuple: ['number', 'number'] } },
};

class Writer {
  readonly functions: string[] = [];
  constructor(private readonly toggles: Toggles) {}

  private next(prefix: string): string { return `${prefix}${this.functions.length}`; }

  /** A boolean expression that is true when `x` (a variable or a read) satisfies `shape`. */
  private test(shape: Shape, x: string): string {
    if (shape === 'number') {
      const { finite } = this.toggles;
      return `typeof ${x} === 'number'${finite === 'sub' ? ` && ${x} - ${x} === 0` : finite === 'isFinite' ? ` && Number.isFinite(${x})` : ''}`;
    }
    if (shape === 'string' || shape === 'boolean') return `typeof ${x} === '${shape}'`;
    if (shape === 'date') return `${x} instanceof Date${this.toggles.date === 'valid' ? ` && ${x}.getTime() - ${x}.getTime() === 0` : ''}`;
    if ('literal' in shape) return `${x} === ${JSON.stringify(shape.literal)}`;
    if ('object' in shape) return `${this.object(shape.object)}(${x})`;
    if ('array' in shape) {
      const name = this.next('a');
      this.functions.push('');
      const slot = this.functions.length - 1;
      this.functions[slot] = `function ${name}(a) { if (!Array.isArray(a)) return false; for (let i = 0; i < a.length; i++) { if (!(${this.test(shape.array, 'a[i]')})) return false; } return true; }`;
      return `${name}(${x})`;
    }
    if ('tuple' in shape) {
      const name = this.next('t');
      this.functions.push('');
      const slot = this.functions.length - 1;
      this.functions[slot] = `function ${name}(a) { return Array.isArray(a) && a.length === ${shape.tuple.length} && ${shape.tuple.map((s, i) => `(${this.test(s, `a[${i}]`)})`).join(' && ')}; }`;
      return `${name}(${x})`;
    }
    const name = this.next('u');
    this.functions.push('');
    const slot = this.functions.length - 1;
    const cases = shape.members.map(member => {
      const tag = member[shape.union];
      if (typeof tag === 'string' || !('literal' in tag)) throw new Error('A union member needs a literal tag');
      return `case ${JSON.stringify(tag.literal)}: return ${this.object(member)}(x);`;
    });
    this.functions[slot] = `function ${name}(x) { if (typeof x !== 'object' || x === null) return false; switch (x.${shape.union}) { ${cases.join(' ')} } return false; }`;
    return `${name}(${x})`;
  }

  /** The name of a function that validates an object with exactly these fields. */
  object(fields: Fields): string {
    const name = this.next('o');
    this.functions.push('');
    const slot = this.functions.length - 1;
    const keys = Object.keys(fields);
    const locals = keys.map((_, i) => `x${i}`);
    const keyCases = keys.map(key => `case ${JSON.stringify(key)}:`).join(' ');
    const reads = keys.map((key, i) => `case ${JSON.stringify(key)}: x${i} = v.${key}; break;`).join(' ');
    const unknownLoop = `for (const k of Object.keys(v)) switch (k) { ${keyCases} break; default: if (v[k] !== undefined) return false; }`;
    let head: string;
    switch (this.toggles.keyTest) {
      case 'F1':
        head = `let ${locals.join(', ')}; for (const k of Object.keys(v)) switch (k) { ${reads} default: if (v[k] !== undefined) return false; }`;
        break;
      case 'F2':
        head = `let m = 0; ${keys.map((key, i) => `const x${i} = pie.call(v, ${JSON.stringify(key)}) ? v.${key} : undefined; if (x${i} !== undefined) m++;`).join(' ')} if (Object.keys(v).length !== m) { ${unknownLoop} }`;
        break;
      case 'count':
        head = `if (Object.keys(v).length !== ${keys.length}) return false; ${keys.map((key, i) => `const x${i} = v.${key};`).join(' ')}`;
        break;
      case 'none':
        head = keys.map((key, i) => `const x${i} = v.${key};`).join(' ');
        break;
    }
    const body = keys.map((key, i) => `(${this.test(fields[key], `x${i}`)})`).join(' && ');
    this.functions[slot] = `function ${name}(v) { if (typeof v !== 'object' || v === null || Array.isArray(v)) return false; ${head} return ${body}; }`;
    return name;
  }
}

/** A validator of the named model with the given costs; it returns true or false and allocates nothing on a pass. */
export function scratchValidator(model: string, toggles: Toggles): (value: unknown, options?: unknown) => boolean {
  const fields = MODELS[model];
  if (!fields) throw new Error(`No scratch model ${model}`);
  const writer = new Writer(toggles);
  const root = writer.object(fields);
  const make = new Function('pie', `${writer.functions.join('\n')}\nreturn ${root};`) as (pie: typeof Object.prototype.propertyIsEnumerable) => (value: unknown) => boolean;
  let validator: (value: unknown, options?: unknown) => boolean = make(Object.prototype.propertyIsEnumerable);
  for (let hop = 0; hop < toggles.hops; hop++) {
    const inner = validator;
    validator = (value, options) => inner(value, options);
  }
  return validator;
}
