/**
 * Scratch validators for the five typia comparison models, written the way the planned fast check (design
 * `validator-speed-design`, section 5) writes them, with one cost switched on or off at a time. They are hand-made
 * JavaScript, not golem output, so no toggle needs product code. Each row of a toggle run names what it changed.
 *
 * The per-item call and the union tag read are written inline by the generator below. The real call chain (codec,
 * generated `validate`, the generated `is_X`) is timed on the generated code itself, beside these rows
 * (typia-validation.ts).
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
  /** `valid` adds `t - t === 0` for a Date; `isFinite` adds `Number.isFinite(x.getTime())`; `off` is `instanceof Date` alone. */
  readonly date: 'valid' | 'isFinite' | 'off';
  /** F1 only. `case` reads a declared value in its own case (spec 5.2); `item` reads every key's value before the switch and skips an `undefined` one. */
  readonly keyRead: 'case' | 'item';
  /** `separate` tests each required key `!== undefined` ahead of the value tests; `implied` leaves that to the value test, which rejects `undefined`. */
  readonly required: 'implied' | 'separate';
  /** `helper` calls a module-level `isObject`; `inline` writes the object test. */
  readonly objectTest: 'inline' | 'helper';
  /** `chain` joins the value tests with `&&`; `statements` copies each value to a `const` and returns `false` after each failed test. */
  readonly body: 'chain' | 'statements';
  /**
   * `read` switches on the plain tag read; `enumerable` reads the tag by the JSON view, picks a branch number, then tests
   * that branch; `merged` reads the declared keys of every branch in one `Object.keys` pass, then switches on the captured
   * tag and tests that branch's values, with each key only another branch declares absent (exact, no `propertyIsEnumerable`).
   */
  readonly tag: 'read' | 'enumerable' | 'merged';
}

export const BASE_TOGGLES: Toggles = { keyTest: 'F1', finite: 'sub', date: 'valid', keyRead: 'case', required: 'implied', objectTest: 'inline', body: 'chain', tag: 'read' };

/** The base with each form the generated `is_X` writes today: what each lead row of a toggle run adds on its own. */
export const GENERATED_TOGGLES: Toggles = { ...BASE_TOGGLES, finite: 'isFinite', date: 'isFinite', keyRead: 'item', required: 'separate', objectTest: 'helper', body: 'statements', tag: 'enumerable' };

type Shape =
  | 'number' | 'string' | 'boolean' | 'date'
  | { readonly literal: string }
  | { readonly optional: Shape }
  | { readonly object: Fields }
  | { readonly array: Shape }
  | { readonly tuple: readonly Shape[] }
  | { readonly union: string; readonly members: readonly Fields[] };
type Fields = Readonly<Record<string, Shape>>;

const address: Fields = { street: 'string', city: 'string', zip: 'string', lat: 'number', lng: 'number' };
const item: Fields = { id: 'number', sku: 'string', name: 'string', price: 'number', quantity: 'number', createdAt: 'date' };

const flat: Fields = { id: 'number', name: 'string', email: 'string', age: 'number', score: 'number', active: 'boolean', createdAt: 'date' };

const MODELS: Readonly<Record<string, Fields>> = {
  flat,
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
  optional: { id: 'number', name: 'string', nickname: { optional: 'string' }, note: { optional: 'string' }, createdAt: 'date' },
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
    if (shape === 'date') {
      const { date } = this.toggles;
      return `${x} instanceof Date${date === 'valid' ? ` && ${x}.getTime() - ${x}.getTime() === 0` : date === 'isFinite' ? ` && Number.isFinite(${x}.getTime())` : ''}`;
    }
    if ('literal' in shape) return `${x} === ${JSON.stringify(shape.literal)}`;
    if ('optional' in shape) return `(${x} === undefined || ${this.test(shape.optional, x)})`;
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
    const members = shape.members.map(member => {
      const tag = member[shape.union];
      if (typeof tag === 'string' || !('literal' in tag)) throw new Error('A union member needs a literal tag');
      return [JSON.stringify(tag.literal), this.object(member)] as const;
    });
    if (this.toggles.tag === 'read') {
      const cases = members.map(([tag, check]) => `case ${tag}: return ${check}(x);`);
      this.functions[slot] = `function ${name}(x) { if (typeof x !== 'object' || x === null) return false; switch (x.${shape.union}) { ${cases.join(' ')} } return false; }`;
    } else if (this.toggles.tag === 'merged') {
      const keys = [...new Set(shape.members.flatMap(member => Object.keys(member)))];
      const local = (key: string): string => `k${keys.indexOf(key)}`;
      const reads = keys.map(key => `case ${JSON.stringify(key)}: ${local(key)} = x[${JSON.stringify(key)}]; break;`).join(' ');
      const cases = shape.members.map(member => {
        const tests = keys.filter(key => key !== shape.union).map(key => (key in member ? this.test(member[key], local(key)) : `${local(key)} === undefined`));
        const tag = member[shape.union];
        if (typeof tag === 'string' || !('literal' in tag)) throw new Error('A union member needs a literal tag');
        return `case ${JSON.stringify(tag.literal)}: return ${tests.map(test => `(${test})`).join(' && ')};`;
      });
      this.functions[slot] = `function ${name}(x) { if (typeof x !== 'object' || x === null || Array.isArray(x)) return false; let ${keys.map(local).join(', ')}; `
        + `for (const k of Object.keys(x)) switch (k) { ${reads} default: if (x[k] !== undefined) return false; } switch (${local(shape.union)}) { ${cases.join(' ')} } return false; }`;
    } else {
      const key = JSON.stringify(shape.union);
      const select = members.map(([tag], position) => `t === ${tag} ? ${position} : `).join('');
      const branches = members.map(([, check], position) => `if (b === ${position}) { if (!${check}(x)) return false; }`).join(' ');
      this.functions[slot] = `function ${name}(x) { const t = isObject(x) ? (pie.call(x, ${key}) ? x[${key}] : undefined) : undefined; const b = ${select}-1; ${branches} if (b < 0) return false; return true; }`;
    }
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
        head = this.toggles.keyRead === 'case'
          ? `let ${locals.join(', ')}; for (const k of Object.keys(v)) switch (k) { ${reads} default: if (v[k] !== undefined) return false; }`
          : `let ${locals.join(', ')}; for (const k of Object.keys(v)) { const item = v[k]; if (item === undefined) continue; switch (k) { ${keys.map((key, i) => `case ${JSON.stringify(key)}: x${i} = item; break;`).join(' ')} default: return false; } }`;
        break;
      case 'F2':
        head = `let m = 0; ${keys.map((key, i) => `const x${i} = pie.call(v, ${JSON.stringify(key)}) ? v.${key} : undefined; if (x${i} !== undefined) m++;`).join(' ')} if (Object.keys(v).length !== m) { ${unknownLoop} }`;
        break;
      case 'count': {
        // With optional fields a valid value can hold fewer keys, so the count is only an upper bound there.
        const optional = keys.some(key => { const shape = fields[key]; return typeof shape === 'object' && 'optional' in shape; });
        head = `if (Object.keys(v).length ${optional ? '>' : '!=='} ${keys.length}) return false; ${keys.map((key, i) => `const x${i} = v.${key};`).join(' ')}`;
        break;
      }
      case 'none':
        head = keys.map((key, i) => `const x${i} = v.${key};`).join(' ');
        break;
    }
    const required = this.toggles.required === 'separate'
      ? keys.filter(key => { const shape = fields[key]; return typeof shape !== 'object' || !('optional' in shape); }).map(key => `x${keys.indexOf(key)} !== undefined`)
      : [];
    const tests = keys.map((key, i) => this.test(fields[key], this.toggles.body === 'chain' ? `x${i}` : `m${i}`));
    const body = this.toggles.body === 'chain'
      ? `return ${[...required, ...tests].map(test => `(${test})`).join(' && ')};`
      : `${required.map(test => `if (!(${test})) return false;`).join(' ')} ${tests.map((test, i) => `const m${i} = x${i}; if (!(${test})) return false;`).join(' ')} return true;`;
    const objectTest = this.toggles.objectTest === 'inline' ? `typeof v !== 'object' || v === null || Array.isArray(v)` : '!isObject(v)';
    this.functions[slot] = `function ${name}(v) { if (${objectTest}) return false; ${head} ${body} }`;
    return name;
  }
}

/** A validator of the named model with the given costs; it returns true or false and allocates nothing on a pass. */
export function scratchValidator(model: string, toggles: Toggles): (value: unknown, options?: unknown) => boolean {
  const fields = MODELS[model];
  if (!fields) throw new Error(`No scratch model ${model}`);
  const writer = new Writer(toggles);
  const root = writer.object(fields);
  const isObject = 'const isObject = value => typeof value === \'object\' && value !== null && !Array.isArray(value);';
  const make = new Function('pie', `${isObject}\n${writer.functions.join('\n')}\nreturn ${root};`) as (pie: typeof Object.prototype.propertyIsEnumerable) => (value: unknown) => boolean;
  return make(Object.prototype.propertyIsEnumerable);
}

/**
 * How a read decides that a declared key is present under the JSON view (own, enumerable, not `undefined`).
 * `enumerable`: `propertyIsEnumerable.call` per key, then the read (golem today). `own`: `hasOwnProperty.call` per key
 * and `!== undefined` (the old form; it counts a non-enumerable own key, so it is not exact). `keys`: one
 * `Object.keys` pass whose switch captures the declared values (exact by construction). `defined-first`: the read
 * first, `propertyIsEnumerable.call` only when it is defined (exact; an absent key costs no call).
 */
export type PresenceForm = 'enumerable' | 'own' | 'keys' | 'defined-first';
export const PRESENCE_FORMS: readonly PresenceForm[] = ['enumerable', 'own', 'keys', 'defined-first'];
export const EXACT_PRESENCE_FORMS: ReadonlySet<PresenceForm> = new Set(['enumerable', 'keys', 'defined-first']);

const PRESENCE_FIELDS = Object.entries(flat);
const PRESENCE_KEYS = PRESENCE_FIELDS.map(([key]) => key);

/** A test of one flat field shape, as the slow validator writes it. */
function flatTest(shape: Shape, x: string): string {
  if (shape === 'number') return `typeof ${x} === 'number' && ${x} - ${x} === 0`;
  if (shape === 'date') return `${x} instanceof Date && ${x}.getTime() - ${x}.getTime() === 0`;
  if (shape === 'string' || shape === 'boolean') return `typeof ${x} === '${shape}'`;
  throw new Error('The presence rows read only flat fields');
}

/** The per-key presence helper of a form that has one; `keys` reads all keys in one pass instead. */
const PRESENT_HELPER: Readonly<Record<Exclude<PresenceForm, 'keys'>, string>> = {
  enumerable: 'const present = (v, k) => pie.call(v, k) && v[k] !== undefined;',
  own: 'const present = (v, k) => hop.call(v, k) && v[k] !== undefined;',
  'defined-first': 'const present = (v, k) => v[k] !== undefined && pie.call(v, k);',
};

const keysCapture = (source: string): string => `let ${PRESENCE_KEYS.map((_, i) => `x${i}`).join(', ')}; `
  + `for (const k of Object.keys(${source})) switch (k) { ${PRESENCE_KEYS.map((key, i) => `case ${JSON.stringify(key)}: x${i} = ${source}.${key}; break;`).join(' ')} }`;

function compilePresence<T>(body: string): T {
  const make = new Function('pie', 'hop', body) as (pie: typeof Object.prototype.propertyIsEnumerable, hop: typeof Object.prototype.hasOwnProperty) => T;
  return make(Object.prototype.propertyIsEnumerable, Object.prototype.hasOwnProperty);
}

/**
 * The slow validator's walk over the seven flat fields: `required` tests each key, then `properties` tests each present
 * key and checks its value. It returns the number of issues.
 */
export function presenceWalk(form: PresenceForm): (value: unknown) => number {
  if (form === 'keys') {
    const checks = PRESENCE_FIELDS.map(([, shape], i) => `if (x${i} === undefined) n++; else if (!(${flatTest(shape, `x${i}`)})) n++;`).join(' ');
    return compilePresence(`return function walk(v) { if (typeof v !== 'object' || v === null) return 1; let n = 0; ${keysCapture('v')} ${checks} return n; };`);
  }
  const required = PRESENCE_KEYS.map(key => `if (!present(v, ${JSON.stringify(key)})) n++;`).join(' ');
  const properties = PRESENCE_FIELDS.map(([key, shape]) => `if (present(v, ${JSON.stringify(key)})) { const m = v.${key}; if (!(${flatTest(shape, 'm')})) n++; }`).join(' ');
  return compilePresence(`${PRESENT_HELPER[form]} return function walk(v) { if (typeof v !== 'object' || v === null) return 1; let n = 0; ${required} ${properties} return n; };`);
}

/** A decode fill of the seven flat fields: a new object holding each present field. */
export function presenceFill(form: PresenceForm): (wire: object) => Record<string, unknown> {
  const writes = PRESENCE_KEYS.map((key, i) => `if (x${i} !== undefined) out.${key} = x${i};`).join(' ');
  if (form === 'keys') return compilePresence(`return function fill(w) { const out = {}; ${keysCapture('w')} ${writes} return out; };`);
  const reads = PRESENCE_KEYS.map((key, i) => {
    const k = JSON.stringify(key);
    if (form === 'enumerable') return `const x${i} = pie.call(w, ${k}) ? w.${key} : undefined;`;
    if (form === 'own') return `const x${i} = hop.call(w, ${k}) ? w.${key} : undefined;`;
    return `let x${i} = w.${key}; if (x${i} !== undefined && !pie.call(w, ${k})) x${i} = undefined;`;
  }).join(' ');
  return compilePresence(`return function fill(w) { const out = {}; ${reads} ${writes} return out; };`);
}
