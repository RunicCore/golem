import type { IrArray, IrCheck, IrDiscriminator, IrFunction, IrInstance, IrModule, IrNumber, IrObject, IrSchema, IrString, IrType, IrTypeName, IrUnion, IrValidation, IrValidationImport } from './ir.js';

export interface EmitOptions {
  /** The module specifier the generated file imports its runtime helpers from. */
  readonly runtimeModule: string;
  /** Types each exported validator as a `Validator`, for a TypeScript file. */
  readonly typed?: boolean;
}

type RuntimeHelper = 'checkFormat' | 'codePointLength' | 'jsonEqual';
type LocalHelper = 'hasOwn' | 'definedKeys' | 'isObject' | 'isMultipleOf' | 'selectedModel' | 'newEvaluation' | 'mergeEvaluation';

// Parameters of every generated function: the value, the path stack, the issue list and the all-errors flag,
// then, for a function that receives an evaluation record (see `IrFunction`), the caller's record. Every call and
// header goes through `functionParameters` and `callFunction`, so a change to the parameter list is made in one place.
const VALUE = 'v';
const PATH = 'p';
const ISSUES = 'i';
const ALL = 'a';
const INHERITED = 'e';
// The record a function keeps or fills, and what it holds.
const EVALUATION = 'r';

function functionParameters(fn: IrFunction): string {
  return [VALUE, PATH, ISSUES, ALL, ...(fn.receives ? [INHERITED] : [])].join(', ');
}

/** The longest part of a schema's name that a function name keeps. */
const NAME_LIMIT = 40;

/** Characters that cannot appear in a name become `_`. */
function identifier(text: string): string {
  return text.replace(/[^A-Za-z0-9_$]/g, '_');
}

/**
 * The name each root's validator is exported under: `validate_` and the root's name, with each character that cannot
 * appear in a name turned into `_`. The name comes from the root alone, so adding a root renames no other export,
 * unless its name becomes an identifier another root already has: roots whose names become the same identifier are
 * told apart by a number from 2, handed out in the order of the roots' own names, so the numbers of that set can shift.
 */
export function exportNames(rootNames: Iterable<string>): ReadonlyMap<string, string> {
  const names = [...new Set(rootNames)].sort((first, second) => (first < second ? -1 : first > second ? 1 : 0));
  const taken = new Set<string>();
  const result = new Map<string, string>();
  for (const name of names) {
    const base = `validate_${identifier(name)}`;
    let candidate = base;
    for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base}_${suffix}`;
    taken.add(candidate);
    result.set(name, candidate);
  }
  return result;
}

/**
 * The name of the function written at position `index` among the functions the module keeps. The index keeps names
 * unique; the schema's name, when it has one, shows in stack traces and profiles.
 */
function functionName(index: number, schemaName?: string): string {
  return schemaName === undefined ? `f${index}` : `f${index}_${identifier(schemaName).slice(0, NAME_LIMIT)}`;
}

/**
 * Stands for a function in the text of another until the module is assembled: the final name depends on which
 * functions turn out to be one. The character cannot occur otherwise, as a string literal escapes it.
 */
const FUNCTION_MARK = /\u0000(\d+)\u0000/g;

function functionMark(id: number): string {
  return `\u0000${id}\u0000`;
}

interface CallArguments {
  readonly value: string;
  readonly path?: string;
  readonly issues: string;
  readonly all: string;
  /** The record to hand to the callee; dropped when the callee takes none. */
  readonly record?: string;
}

function callFunction(callee: IrFunction, name: string, args: CallArguments): string {
  const record = callee.receives && args.record !== undefined ? [args.record] : [];
  return `${name}(${[args.value, args.path ?? PATH, args.issues, args.all, ...record].join(', ')})`;
}

const LOCAL_HELPERS: Readonly<Record<LocalHelper, string>> = {
  // A key whose value is `undefined` is absent: a model's optional field may be set to `undefined` and JSON has no such value.
  definedKeys: 'const definedKeys = value => Object.keys(value).filter(key => value[key] !== undefined);',
  hasOwn: 'const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;',
  isObject: "const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);",
  // The quotient of two doubles is off by rounding (0.3 / 0.1), so a quotient within a few ulps of a non-zero
  // whole number counts. An infinite quotient falls back to the exact remainder.
  isMultipleOf: [
    'function isMultipleOf(value, divisor) {',
    '  const quotient = value / divisor;',
    '  if (!Number.isFinite(quotient)) return value % divisor === 0;',
    '  if (Number.isInteger(quotient)) return true;',
    '  const nearest = Math.round(quotient);',
    '  return nearest !== 0 && Math.abs(quotient - nearest) <= 4 * Number.EPSILON * Math.abs(nearest);',
    '}',
  ].join('\n'),
  // The registered model class a value is an instance of, as `golemModelInstance` reads it. The symbol key must match
  // `MODEL_CODEC_IDS` in object-codec.ts: the generated module imports nothing that registers classes. The most derived
  // registered prototype on the chain wins. A hashed codec id (`Name_1a2b3c4d`) matches exactly; an unhashed name also
  // matches the hashed ids of that name.
  selectedModel: [
    'const hashedId = /_[0-9a-f]{8}$/;',
    'function selectedModel(value, among) {',
    "  if (typeof value !== 'object' || value === null) return undefined;",
    '  const key = Symbol.for("@exprtlabs/golem:modelCodecIds");',
    '  const matches = (registered, id) => registered === id',
    '    || (!hashedId.test(id) && registered.length === id.length + 9 && registered.startsWith(id + "_") && hashedId.test(registered));',
    '  for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {',
    '    if (!Object.prototype.hasOwnProperty.call(prototype, key)) continue;',
    '    for (const id of among) if (prototype[key].some(registered => matches(registered, id))) return id;',
    '  }',
    '  return undefined;',
    '}',
  ].join('\n'),
  // What the keywords of one value evaluated: keys by name, or all of them; leading items by count, others by
  // index, or all of them.
  newEvaluation: 'const newEvaluation = () => ({ keys: new Set(), allKeys: false, prefix: 0, indexes: new Set(), allItems: false });',
  mergeEvaluation: [
    'function mergeEvaluation(into, from) {',
    '  for (const key of from.keys) into.keys.add(key);',
    '  for (const index of from.indexes) into.indexes.add(index);',
    '  into.allKeys = into.allKeys || from.allKeys;',
    '  into.prefix = Math.max(into.prefix, from.prefix);',
    '  into.allItems = into.allItems || from.allItems;',
    '}',
  ].join('\n'),
};

const TYPE_TESTS: Readonly<Record<IrTypeName, (value: string) => string>> = {
  string: value => `typeof ${value} === 'string'`,
  // JSON has no NaN or infinity; a model value that holds one is not a number.
  number: value => `(typeof ${value} === 'number' && Number.isFinite(${value}))`,
  integer: value => `Number.isInteger(${value})`,
  boolean: value => `typeof ${value} === 'boolean'`,
  null: value => `${value} === null`,
  object: value => `isObject(${value})`,
  array: value => `Array.isArray(${value})`,
};

/** A string literal of the generated module. */
function literal(text: string): string {
  return JSON.stringify(text);
}

/** Module-level state the function bodies add to while they are emitted. */
class ModuleState {
  private readonly runtime = new Set<RuntimeHelper>();
  private readonly helpers = new Set<LocalHelper>();
  private readonly declarations: string[] = [];
  /** The name of each declared constant, by what it holds: one constant serves every use of the same value. */
  private readonly constants = new Map<string, string>();
  private imports: readonly IrValidationImport[] = [];

  public runtimeHelper(name: RuntimeHelper): string {
    this.runtime.add(name);
    return name;
  }

  public localHelper(name: LocalHelper): string {
    this.helpers.add(name);
    return name;
  }

  public importValidations(imports: readonly IrValidationImport[]): void {
    this.imports = imports;
  }

  /** The local name of the validation function at `index` of the module's imports. */
  public validationFunction(index: number): string {
    return `v${index}`;
  }

  /**
   * Declares a module-level constant and returns its name. A constant that holds the same value, as `key` says
   * (the expression itself by default), is declared once. Every initializer is a call or a `new`, so it carries the
   * annotation that lets a bundler drop the constant with the validator that alone uses it; a call among its
   * arguments carries the annotation too, as a bundler keeps a pure call whose arguments may have side effects.
   */
  public constant(prefix: string, expression: string, key = expression): string {
    const identity = `${prefix}\u0000${key}`;
    const known = this.constants.get(identity);
    if (known !== undefined) return known;
    const name = `${prefix}${this.declarations.length}`;
    this.declarations.push(`const ${name} = /*#__PURE__*/ ${expression};`);
    this.constants.set(identity, name);
    return name;
  }

  public prelude(runtimeModule: string): string[] {
    const lines: string[] = [];
    if (this.runtime.size > 0) lines.push(`import { ${[...this.runtime].sort().join(', ')} } from ${literal(runtimeModule)};`);
    this.imports.forEach((entry, index) => {
      const exported = /^[A-Za-z_$][\w$]*$/.test(entry.exportName) ? entry.exportName : literal(entry.exportName);
      lines.push(`import { ${exported} as ${this.validationFunction(index)} } from ${literal(entry.importPath)};`);
    });
    for (const name of Object.keys(LOCAL_HELPERS) as LocalHelper[]) if (this.helpers.has(name)) lines.push(LOCAL_HELPERS[name]);
    return [...lines, ...this.declarations];
  }
}

/** Writes one function. A failed check pushes its issue, then returns at once unless all errors are wanted. */
class FunctionWriter {
  private readonly lines: string[] = [];
  private depth = 1;
  private counter = 0;
  /** The record that checks of the value being checked fill; undefined when this function keeps none, or while a child value is checked. */
  private record: string | undefined;

  /** The functions this one calls, by the id they have after forwarding. */
  public readonly calls = new Set<number>();

  public constructor(
    private readonly state: ModuleState,
    private readonly functions: readonly IrFunction[],
    private readonly target: (id: number) => number,
    private readonly fn: IrFunction,
  ) {
    this.record = fn.collects || fn.receives ? EVALUATION : undefined;
  }

  /** The body of the function, without its header line. */
  public write(): string {
    this.line(`const pl = ${PATH}.length;`);
    this.line('let ok = true;');
    if (this.fn.collects) this.line(`const ${EVALUATION} = ${this.state.localHelper('newEvaluation')}();`);
    else if (this.fn.receives) this.line(`const ${EVALUATION} = ${INHERITED} ?? ${this.state.localHelper('newEvaluation')}();`);
    this.schema(this.fn.body, VALUE);
    // A function that both keeps a record and receives one hands what it evaluated to its caller once it passed.
    if (this.fn.collects && this.fn.receives) this.line(`if (ok && ${INHERITED} !== undefined) ${this.state.localHelper('mergeEvaluation')}(${INHERITED}, ${EVALUATION});`);
    this.line('return ok;');
    this.lines.push('}');
    return this.lines.join('\n');
  }

  private line(text: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}${text}`);
  }

  /** Opens a block; an empty `head` opens a bare scope. */
  private open(head: string): void {
    this.line(head === '' ? '{' : `${head} {`);
    this.depth++;
  }

  private close(): void {
    this.depth--;
    this.line('}');
  }

  /** A block that is left out when `body` writes nothing, as when a check only marks what it evaluates and nothing reads the mark. */
  private block(head: string, body: () => void): void {
    const start = this.lines.length;
    this.open(head);
    body();
    if (this.lines.length === start + 1) {
      this.lines.length = start;
      this.depth--;
    } else {
      this.close();
    }
  }

  private fresh(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  /** Records the issue at `path` (the current path by default) and ends the function unless all errors are wanted. */
  private issue(fields: string, path = `${PATH}.slice()`): void {
    this.line(`${ISSUES}.push({ path: ${path}, ${fields} });`);
    this.fail();
  }

  private fail(): void {
    this.line(`ok = false; if (!${ALL}) { ${PATH}.length = pl; return false; }`);
  }

  /** `limit` is a number, or an expression of the generated code. */
  private limitIssue(code: 'tooSmall' | 'tooBig', measure: string, limit: number | string, inclusive: boolean): void {
    this.issue(`code: ${literal(code)}, measure: ${literal(measure)}, limit: ${typeof limit === 'number' ? JSON.stringify(limit) : limit}, inclusive: ${inclusive}`);
  }

  /** Adds a statement that marks what the current value evaluated, when this function keeps a record. */
  private mark(statement: (record: string) => string): void {
    if (this.record !== undefined) this.line(statement(this.record));
  }

  private requireRecord(): string {
    if (this.record === undefined) throw new Error('A check that reads evaluated keys or items needs a function that keeps a record.');
    return this.record;
  }

  private call(id: number, args: CallArguments): string {
    const target = this.target(id);
    this.calls.add(target);
    return callFunction(this.functions[target], functionMark(target), args);
  }

  /** The function `id` applies to the same value in place: it fails this function when it fails, and fills this function's record. */
  private callInPlace(id: number, value: string): void {
    this.open(`if (!${this.call(id, { value, issues: ISSUES, all: ALL, record: this.record })})`);
    this.fail();
    this.close();
  }

  private schema(schema: IrSchema, value: string): void {
    if (schema.kind === 'never') this.issue("code: 'never'");
    else if (schema.kind === 'checks') this.checks(schema.checks, value);
  }

  private checks(checks: readonly IrCheck[], value: string): void {
    for (let position = 0; position < checks.length; position++) {
      const check = checks[position];
      const next = checks[position + 1];
      // A value that is not an object has already failed the type check, so the object keywords have nothing to test.
      if (check.kind === 'type' && check.names.every(name => name === 'object') && next?.kind === 'object') {
        this.objectOrTypeIssue(check, next, value);
        position++;
      } else {
        this.check(check, value);
      }
    }
  }

  /** Runs `body` for the child `token` of the current value with the path extended; the child has its own evaluation, so no record is filled. */
  private atChild(token: string, body: () => void): void {
    const record = this.record;
    this.record = undefined;
    this.line(`${PATH}.push(${token});`);
    body();
    this.line(`${PATH}.pop();`);
    this.record = record;
  }

  private check(check: IrCheck, value: string): void {
    switch (check.kind) {
      case 'type': {
        const tests = check.names.map(name => TYPE_TESTS[name](value));
        if (check.names.includes('object')) this.state.localHelper('isObject');
        this.open(`if (!(${tests.join(' || ')}))`);
        this.issue(`code: 'type', expected: ${JSON.stringify(check.names)}`);
        this.close();
        return;
      }
      case 'literal': {
        const jsonEqual = this.state.runtimeHelper('jsonEqual');
        const values = this.state.constant('lit', `Object.freeze(/*#__PURE__*/ JSON.parse(${literal(JSON.stringify(check.values))}))`);
        const missing = check.values.length === 1 ? `!${jsonEqual}(${value}, ${values}[0])` : `!${values}.some(item => ${jsonEqual}(${value}, item))`;
        this.open(`if (${missing})`);
        this.issue(`code: 'literal', expected: ${values}`);
        this.close();
        return;
      }
      case 'format': {
        this.open(`if (!${this.state.runtimeHelper('checkFormat')}(${literal(check.format)}, ${value}))`);
        this.issue(`code: 'format', format: ${literal(check.format)}`);
        this.close();
        return;
      }
      case 'date':
        this.open(`if (!(${value} instanceof Date) || !Number.isFinite(${value}.getTime()))`);
        this.issue("code: 'type', expected: ['Date']");
        this.close();
        return;
      case 'instance': return this.instanceCheck(check, value);
      case 'validation': return this.validationCheck(check, value);
      case 'string': return this.stringCheck(check, value);
      case 'number': return this.numberCheck(check, value);
      case 'array': return this.arrayCheck(check, value);
      case 'object': return this.objectCheck(check, value);
      case 'call': return this.callInPlace(check.fn, value);
      case 'allOf':
        for (const branch of check.branches) this.schema(branch, value);
        return;
      case 'union': return check.discriminator ? this.discriminatedUnion(check, check.discriminator, value) : this.unionCheck(check, value);
      case 'not':
        this.open(`if (${this.call(check.fn, { value, issues: '[]', all: 'false' })})`);
        this.issue("code: 'not'");
        this.close();
        return;
      case 'conditional': return this.conditionalCheck(check, value);
      case 'dependentSchemas': {
        this.state.localHelper('isObject');
        const hasOwn = this.state.localHelper('hasOwn');
        this.open(`if (isObject(${value}))`);
        for (const { trigger, fn } of check.entries) {
          this.open(`if (${hasOwn}(${value}, ${literal(trigger)}))`);
          this.callInPlace(fn, value);
          this.close();
        }
        this.close();
        return;
      }
      case 'unevaluatedProperties': return this.unevaluatedProperties(check.schema, value);
      case 'unevaluatedItems': return this.unevaluatedItems(check.schema, value);
    }
  }

  /** The class the value's encoder selects must be `of`; see `IrInstance`. */
  private instanceCheck(check: IrInstance, value: string): void {
    const selected = this.fresh('selected');
    this.line(`const ${selected} = ${this.state.localHelper('selectedModel')}(${value}, ${JSON.stringify(check.among)});`);
    const expected = check.of === undefined ? 'undefined' : literal(check.of);
    this.open(check.required || check.of === undefined
      ? `if (${selected} !== ${expected})`
      : `if (${selected} !== undefined && ${selected} !== ${expected})`);
    this.issue(`code: 'instance', model: ${literal(check.of ?? check.among[0])}`);
    this.close();
  }

  /** The functions run only after the structural schema passed, so they never see a value of the wrong shape. */
  private validationCheck(check: IrValidation, value: string): void {
    const runCalls = (): void => {
      for (const index of check.calls) {
        const result = this.fresh('result');
        this.line(`const ${result} = ${this.state.validationFunction(index)}(${value});`);
        this.open(`if (typeof ${result} !== 'boolean' && typeof ${result} !== 'string')`);
        this.line('throw new TypeError("Validation functions must return boolean or string.");');
        this.close();
        this.open(`if (${result} !== true)`);
        this.issue(`code: 'custom', ...(typeof ${result} === 'string' && ${result}.length > 0 ? { reason: ${result} } : {})`);
        this.close();
      }
    };
    if (check.fn === undefined) return runCalls();
    this.open(`if (${this.call(check.fn, { value, issues: ISSUES, all: ALL, record: this.record })})`);
    runCalls();
    this.close();
    this.open('else');
    this.fail();
    this.close();
  }

  private stringCheck(check: IrString, value: string): void {
    this.open(`if (typeof ${value} === 'string')`);
    if (check.minLength !== undefined || check.maxLength !== undefined) {
      const length = this.fresh('n');
      this.line(`const ${length} = ${this.state.runtimeHelper('codePointLength')}(${value});`);
      if (check.minLength !== undefined) {
        this.open(`if (${length} < ${JSON.stringify(check.minLength)})`);
        this.limitIssue('tooSmall', 'length', check.minLength, true);
        this.close();
      }
      if (check.maxLength !== undefined) {
        this.open(`if (${length} > ${JSON.stringify(check.maxLength)})`);
        this.limitIssue('tooBig', 'length', check.maxLength, true);
        this.close();
      }
    }
    if (check.pattern !== undefined) {
      const expression = this.state.constant('pattern', `new RegExp(${literal(check.pattern)}, 'u')`);
      this.open(`if (!${expression}.test(${value}))`);
      this.issue(`code: 'pattern', pattern: ${literal(check.pattern)}`);
      this.close();
    }
    this.close();
  }

  private numberCheck(check: IrNumber, value: string): void {
    this.open(`if (typeof ${value} === 'number')`);
    const bounds = [
      ['minimum', '<', 'tooSmall', true],
      ['exclusiveMinimum', '<=', 'tooSmall', false],
      ['maximum', '>', 'tooBig', true],
      ['exclusiveMaximum', '>=', 'tooBig', false],
    ] as const;
    for (const [keyword, operator, code, inclusive] of bounds) {
      const limit = check[keyword];
      if (limit === undefined) continue;
      this.open(`if (${value} ${operator} ${JSON.stringify(limit)})`);
      this.limitIssue(code, 'value', limit, inclusive);
      this.close();
    }
    if (check.multipleOf !== undefined) {
      this.open(`if (!${this.state.localHelper('isMultipleOf')}(${value}, ${JSON.stringify(check.multipleOf)}))`);
      this.issue(`code: 'multipleOf', divisor: ${JSON.stringify(check.multipleOf)}`);
      this.close();
    }
    this.close();
  }

  private arrayCheck(check: IrArray, value: string): void {
    this.block(`if (Array.isArray(${value}))`, () => {
      if (check.minItems !== undefined) {
        this.open(`if (${value}.length < ${JSON.stringify(check.minItems)})`);
        this.limitIssue('tooSmall', 'items', check.minItems, true);
        this.close();
      }
      if (check.maxItems !== undefined) {
        this.open(`if (${value}.length > ${JSON.stringify(check.maxItems)})`);
        this.limitIssue('tooBig', 'items', check.maxItems, true);
        this.close();
      }
      if (check.closed) {
        this.open(`if (${value}.length > ${check.prefixItems.length})`);
        this.limitIssue('tooBig', 'items', check.prefixItems.length, true);
        this.close();
      }
      if (check.prefixItems.length > 0) this.mark(record => `${record}.prefix = Math.max(${record}.prefix, Math.min(${value}.length, ${check.prefixItems.length}));`);
      check.prefixItems.forEach((schema, position) => {
        if (schema.kind === 'always') return;
        this.open(`if (${value}.length > ${position})`);
        const item = this.fresh('item');
        this.line(`const ${item} = ${value}[${position}];`);
        this.atChild(String(position), () => this.schema(schema, item));
        this.close();
      });
      if (check.items !== undefined || check.closed) this.mark(record => `${record}.allItems = true;`);
      if (check.items !== undefined && check.items.kind !== 'always') {
        const index = this.fresh('x');
        const item = this.fresh('item');
        const items = check.items;
        this.open(`for (let ${index} = ${check.prefixItems.length}; ${index} < ${value}.length; ${index}++)`);
        this.line(`const ${item} = ${value}[${index}];`);
        this.atChild(index, () => this.schema(items, item));
        this.close();
      }
      if (check.contains !== undefined) this.containsCheck(check.contains, value);
      if (check.uniqueItems) {
        const first = this.fresh('x');
        const second = this.fresh('y');
        const label = this.fresh('unique');
        const jsonEqual = this.state.runtimeHelper('jsonEqual');
        this.open(`${label}: for (let ${first} = 0; ${first} < ${value}.length - 1; ${first}++)`);
        this.open(`for (let ${second} = ${first} + 1; ${second} < ${value}.length; ${second}++)`);
        this.open(`if (${jsonEqual}(${value}[${first}], ${value}[${second}]))`);
        this.line(`${ISSUES}.push({ path: ${PATH}.slice(), code: 'unique', indexes: [${first}, ${second}] });`);
        this.fail();
        this.line(`break ${label};`);
        this.close();
        this.close();
        this.close();
      }
    });
  }

  /** Counts the items that pass `contains`; the count must lie between its limits, and each match counts as evaluated. */
  private containsCheck(contains: NonNullable<IrArray['contains']>, value: string): void {
    const marks = this.record !== undefined;
    if (contains.min === 0 && contains.max === undefined && !marks) return;
    const count = this.fresh('count');
    const index = this.fresh('x');
    this.line(`let ${count} = 0;`);
    this.open(`for (let ${index} = 0; ${index} < ${value}.length; ${index}++)`);
    this.open(`if (${this.call(contains.fn, { value: `${value}[${index}]`, issues: '[]', all: 'false' })})`);
    this.line(`${count}++;`);
    this.mark(record => `${record}.indexes.add(${index});`);
    // Without a maximum or a record, the first `min` matches decide the outcome.
    if (contains.max === undefined && !marks) this.line(`if (${count} >= ${contains.min}) break;`);
    this.close();
    this.close();
    if (contains.min > 0) {
      this.open(`if (${count} < ${JSON.stringify(contains.min)})`);
      this.limitIssue('tooSmall', 'matches', contains.min, true);
      this.close();
    }
    if (contains.max !== undefined) {
      this.open(`if (${count} > ${JSON.stringify(contains.max)})`);
      this.limitIssue('tooBig', 'matches', contains.max, true);
      this.close();
    }
  }

  private objectCheck(check: IrObject, value: string): void {
    this.state.localHelper('isObject');
    this.block(`if (isObject(${value}))`, () => this.objectKeywords(check, value));
  }

  /** The type check that requires an object, and the object keywords in its `else`: the value is tested once. */
  private objectOrTypeIssue(type: IrType, check: IrObject, value: string): void {
    this.state.localHelper('isObject');
    this.open(`if (!isObject(${value}))`);
    this.issue(`code: 'type', expected: ${JSON.stringify(type.names)}`);
    this.depth--;
    this.line('} else {');
    this.depth++;
    const start = this.lines.length;
    this.objectKeywords(check, value);
    if (this.lines.length === start) {
      this.lines.pop();
      this.depth--;
      this.line('}');
    } else {
      this.close();
    }
  }

  private objectKeywords(check: IrObject, value: string): void {
    const hasOwn = this.state.localHelper('hasOwn');
    const marks = this.record !== undefined;
    // A key that matches a pattern is not "additional" even when the pattern's schema accepts everything.
    const patterns = check.patternProperties.map(entry => ({ entry, expression: this.state.constant('pattern', `new RegExp(${literal(entry.pattern)}, 'u')`) }));
    const patternsToRun = patterns.filter(({ entry }) => entry.schema.kind !== 'always' || marks);
    const visitsAdditional = check.additional !== undefined && (check.additional.kind === 'forbid' || check.additional.schema.kind !== 'always');
    const keys = this.fresh('keys');
    if (check.minProperties !== undefined || check.maxProperties !== undefined || patternsToRun.length > 0 || visitsAdditional || check.propertyNames !== undefined) {
      this.line(`const ${keys} = ${this.state.localHelper('definedKeys')}(${value});`);
    }
    if (check.minProperties !== undefined) {
      this.open(`if (${keys}.length < ${JSON.stringify(check.minProperties)})`);
      this.limitIssue('tooSmall', 'properties', check.minProperties, true);
      this.close();
    }
    if (check.maxProperties !== undefined) {
      this.open(`if (${keys}.length > ${JSON.stringify(check.maxProperties)})`);
      this.limitIssue('tooBig', 'properties', check.maxProperties, true);
      this.close();
    }
    for (const key of check.required) {
      this.open(`if (!${hasOwn}(${value}, ${literal(key)}))`);
      this.issue(`code: 'required', key: ${literal(key)}`, `[...${PATH}, ${literal(key)}]`);
      this.close();
    }
    for (const { trigger, keys: dependents } of check.dependentRequired) {
      if (dependents.length === 0) continue;
      this.open(`if (${hasOwn}(${value}, ${literal(trigger)}))`);
      for (const key of dependents) {
        this.open(`if (!${hasOwn}(${value}, ${literal(key)}))`);
        this.issue(`code: 'required', key: ${literal(key)}`, `[...${PATH}, ${literal(key)}]`);
        this.close();
      }
      this.close();
    }
    // Ahead of `properties`: with fail-fast the first issue is the object's own unknown key.
    if (check.additional && visitsAdditional) {
      const additional = check.additional;
      const key = this.fresh('key');
      const known = check.properties.length > 0 ? this.state.constant('known', `new Set(${JSON.stringify(check.properties.map(property => property.key))})`, JSON.stringify([...new Set(check.properties.map(property => property.key))].sort())) : undefined;
      const skipped = [...(known === undefined ? [] : [`${known}.has(${key})`]), ...patterns.map(({ expression }) => `${expression}.test(${key})`)];
      this.open(`for (const ${key} of ${keys})`);
      if (skipped.length > 0) this.line(`if (${skipped.join(' || ')}) continue;`);
      if (additional.kind === 'forbid') {
        this.issue(`code: 'unknownKey', key: ${key}`, `[...${PATH}, ${key}]`);
      } else {
        const schema = additional.schema;
        const member = this.fresh('member');
        this.line(`const ${member} = ${value}[${key}];`);
        this.atChild(key, () => this.schema(schema, member));
      }
      this.close();
    }
    for (const property of check.properties) {
      if (property.schema.kind === 'always' && !marks) continue;
      const schema = property.schema;
      this.open(`if (${hasOwn}(${value}, ${literal(property.key)}))`);
      this.mark(record => `${record}.keys.add(${literal(property.key)});`);
      if (schema.kind !== 'always') {
        const member = this.fresh('member');
        this.line(`const ${member} = ${value}[${literal(property.key)}];`);
        this.atChild(literal(property.key), () => this.schema(schema, member));
      }
      this.close();
    }
    if (patternsToRun.length > 0) {
      const key = this.fresh('key');
      this.open(`for (const ${key} of ${keys})`);
      for (const { entry, expression } of patternsToRun) {
        this.open(`if (${expression}.test(${key}))`);
        this.mark(record => `${record}.keys.add(${key});`);
        if (entry.schema.kind !== 'always') {
          const schema = entry.schema;
          const member = this.fresh('member');
          this.line(`const ${member} = ${value}[${key}];`);
          this.atChild(key, () => this.schema(schema, member));
        }
        this.close();
      }
      this.close();
    }
    // `additionalProperties` takes every key the other two did not.
    if (check.additional !== undefined) this.mark(record => `${record}.allKeys = true;`);
    if (check.propertyNames !== undefined) {
      const key = this.fresh('key');
      this.open(`for (const ${key} of ${keys})`);
      this.open(`if (!${this.call(check.propertyNames, { value: key, issues: '[]', all: 'false' })})`);
      this.issue(`code: 'invalidKey', key: ${key}`);
      this.close();
      this.close();
    }
  }

  /** `unevaluatedProperties`: the keys that nothing evaluated. */
  private unevaluatedProperties(schema: IrSchema, value: string): void {
    const record = this.requireRecord();
    this.state.localHelper('isObject');
    this.open(`if (isObject(${value}))`);
    if (schema.kind !== 'always') {
      const key = this.fresh('key');
      this.open(`if (!${record}.allKeys)`);
      this.open(`for (const ${key} of ${this.state.localHelper('definedKeys')}(${value}))`);
      this.line(`if (${record}.keys.has(${key})) continue;`);
      if (schema.kind === 'never') {
        this.issue(`code: 'unknownKey', key: ${key}`, `[...${PATH}, ${key}]`);
      } else {
        const member = this.fresh('member');
        this.line(`const ${member} = ${value}[${key}];`);
        this.atChild(key, () => this.schema(schema, member));
      }
      this.close();
      this.close();
    }
    this.line(`${record}.allKeys = true;`);
    this.close();
  }

  /** `unevaluatedItems`: the items that nothing evaluated. `false` gives one `tooBig` issue with the number of evaluated items as the limit. */
  private unevaluatedItems(schema: IrSchema, value: string): void {
    const record = this.requireRecord();
    this.open(`if (Array.isArray(${value}))`);
    if (schema.kind !== 'always') {
      const index = this.fresh('x');
      const unevaluated = this.fresh('unevaluated');
      this.open(`if (!${record}.allItems)`);
      if (schema.kind === 'never') this.line(`let ${unevaluated} = 0;`);
      this.open(`for (let ${index} = 0; ${index} < ${value}.length; ${index}++)`);
      this.line(`if (${index} < ${record}.prefix || ${record}.indexes.has(${index})) continue;`);
      if (schema.kind === 'never') {
        this.line(`${unevaluated}++;`);
      } else {
        const item = this.fresh('item');
        this.line(`const ${item} = ${value}[${index}];`);
        this.atChild(index, () => this.schema(schema, item));
      }
      this.close();
      if (schema.kind === 'never') {
        this.open(`if (${unevaluated} > 0)`);
        this.limitIssue('tooBig', 'items', `${value}.length - ${unevaluated}`, true);
        this.close();
      }
      this.close();
    }
    this.line(`${record}.allItems = true;`);
    this.close();
  }

  /** `if` runs with a scratch list and, when this function keeps a record, a scratch record that counts only when `if` passes. */
  private conditionalCheck(check: Extract<IrCheck, { kind: 'conditional' }>, value: string): void {
    const scratch = this.record === undefined ? undefined : this.fresh('scratch');
    if (scratch !== undefined) this.line(`const ${scratch} = ${this.state.localHelper('newEvaluation')}();`);
    this.open(`if (${this.call(check.if, { value, issues: '[]', all: 'false', record: scratch })})`);
    if (scratch !== undefined && this.record !== undefined) this.line(`${this.state.localHelper('mergeEvaluation')}(${this.record}, ${scratch});`);
    if (check.then !== undefined) this.callInPlace(check.then, value);
    this.close();
    if (check.else !== undefined) {
      this.open('else');
      this.callInPlace(check.else, value);
      this.close();
    }
  }

  private unionCheck(check: IrUnion, value: string): void {
    if (this.record !== undefined) return this.recordingUnionCheck(check, value);
    const attempt = (fn: number): string => this.call(fn, { value, issues: '[]', all: 'false' });
    if (!check.exactlyOne) {
      this.open(`if (!(${check.branches.map(attempt).join(' || ')}))`);
      this.issue("code: 'union', matched: 0");
      this.close();
      return;
    }
    const matched = this.fresh('matched');
    this.line(`let ${matched} = 0;`);
    // Two matches already decide the outcome, so later branches are not run.
    check.branches.forEach((fn, position) => this.line(`if (${position === 0 ? '' : `${matched} < 2 && `}${attempt(fn)}) ${matched}++;`));
    this.open(`if (${matched} !== 1)`);
    this.issue(`code: 'union', matched: ${matched}`);
    this.close();
  }

  /** Every branch that passes marks what it evaluated, so `anyOf` runs all of its branches here. */
  private recordingUnionCheck(check: IrUnion, value: string): void {
    const record = this.requireRecord();
    const matched = this.fresh('matched');
    this.line(`let ${matched} = 0;`);
    check.branches.forEach((fn, position) => {
      const scratch = this.fresh('scratch');
      this.open(position === 0 || !check.exactlyOne ? '' : `if (${matched} < 2)`);
      this.line(`const ${scratch} = ${this.state.localHelper('newEvaluation')}();`);
      this.open(`if (${this.call(fn, { value, issues: '[]', all: 'false', record: scratch })})`);
      this.line(`${matched}++;`);
      this.line(`${this.state.localHelper('mergeEvaluation')}(${record}, ${scratch});`);
      this.close();
      this.close();
    });
    this.open(check.exactlyOne ? `if (${matched} !== 1)` : `if (${matched} === 0)`);
    this.issue(`code: 'union', matched: ${matched}`);
    this.close();
  }

  /** The tag selects the branch; only that branch's issues are reported, and an unknown tag is a `literal` issue on the tag property. */
  private discriminatedUnion(check: IrUnion, discriminator: IrDiscriminator, value: string): void {
    this.state.localHelper('isObject');
    const hasOwn = this.state.localHelper('hasOwn');
    const jsonEqual = this.state.runtimeHelper('jsonEqual');
    const tags = this.state.constant('tags', `Object.freeze(/*#__PURE__*/ JSON.parse(${literal(JSON.stringify(discriminator.tags))}))`);
    const allTags = this.state.constant('lit', `Object.freeze(/*#__PURE__*/ JSON.parse(${literal(JSON.stringify(discriminator.tags.flat()))}))`);
    const tag = this.fresh('tag');
    const selected = this.fresh('branch');
    const property = literal(discriminator.property);
    this.line(`const ${tag} = isObject(${value}) && ${hasOwn}(${value}, ${property}) ? ${value}[${property}] : undefined;`);
    this.line(`const ${selected} = ${tags}.findIndex(list => list.some(item => ${jsonEqual}(${tag}, item)));`);
    check.branches.forEach((fn, position) => {
      this.open(`if (${selected} === ${position})`);
      this.callInPlace(fn, value);
      this.close();
    });
    this.open(`if (${selected} < 0)`);
    this.issue(`code: 'literal', expected: ${allTags}`, `[...${PATH}, ${property}]`);
    this.close();
  }
}

/**
 * The function that stands for `id`: a function whose body only passes the value to another one (a `$ref`, or a
 * schema that is nothing else) is that other function. It must take the evaluation record the other takes, so a
 * caller passes the same arguments either way.
 */
function forwardingTarget(functions: readonly IrFunction[]): (id: number) => number {
  const forwardsTo = (fn: IrFunction): number | undefined => {
    if (fn.collects || fn.body.kind !== 'checks' || fn.body.checks.length !== 1) return undefined;
    const [only] = fn.body.checks;
    return only.kind === 'call' && functions[only.fn].receives === fn.receives ? only.fn : undefined;
  };
  return id => {
    // A forwarding cycle is a `$ref` cycle, which the lowering reports; the guard only stops the walk.
    const seen = new Set<number>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const next = forwardsTo(functions[current]);
      if (next === undefined) break;
      current = next;
    }
    return current;
  };
}

interface WrittenFunction {
  readonly id: number;
  readonly parameters: string;
  /** The body, with the functions it calls as marks. */
  readonly body: string;
  readonly calls: ReadonlySet<number>;
}

function writeFunction(state: ModuleState, module: IrModule, target: (id: number) => number, fn: IrFunction): WrittenFunction {
  const writer = new FunctionWriter(state, module.functions, target, fn);
  const body = writer.write();
  return { id: fn.id, parameters: functionParameters(fn), body, calls: writer.calls };
}

/**
 * Groups the functions that behave alike: those with the same parameters whose bodies are the same text once each
 * call names the group of its callee. Groups start as one and split until stable, so recursive functions that
 * mirror each other (a model and its wire form) end up together. A group is named by its lowest id.
 */
function groupFunctions(written: readonly WrittenFunction[]): ReadonlyMap<number, number> {
  let groups = new Map<number, number>(written.map(entry => [entry.id, 0]));
  let size = 1;
  for (;;) {
    const keys = new Map<string, number>();
    const next = new Map<number, number>();
    for (const entry of written) {
      const body = entry.body.replace(FUNCTION_MARK, (_, id: string) => functionName(groups.get(Number(id)) ?? -1));
      const key = `${groups.get(entry.id)}\n${entry.parameters}\n${body}`;
      if (!keys.has(key)) keys.set(key, keys.size);
      next.set(entry.id, keys.get(key) ?? 0);
    }
    if (keys.size === size) break;
    groups = next;
    size = keys.size;
  }
  const lowest = new Map<number, number>();
  for (const entry of written) {
    const group = groups.get(entry.id) ?? 0;
    if (!lowest.has(group)) lowest.set(group, entry.id);
  }
  return new Map(written.map(entry => [entry.id, lowest.get(groups.get(entry.id) ?? 0) ?? entry.id]));
}

/**
 * Emits the module: one function per distinct behavior and one exported wrapper per root, named by `exportNames`.
 * Every check is written once: a forwarding function, and a function the same as another, are not emitted, and
 * their callers call the one that is.
 */
export function emit(module: IrModule, options: EmitOptions): string {
  const target = forwardingTarget(module.functions);
  // First pass: every function as text, to learn which of those the roots reach are the same.
  const survey = new ModuleState();
  survey.importValidations(module.validations);
  const written = new Map(module.functions.filter(fn => target(fn.id) === fn.id).map(fn => [fn.id, writeFunction(survey, module, target, fn)] as const));
  const reached = new Set<number>();
  const pending = module.exports.map(({ fn }) => target(fn));
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...(written.get(id)?.calls ?? []));
  }
  const representative = groupFunctions([...written.values()].filter(entry => reached.has(entry.id)));
  const kept = [...new Set(representative.values())].sort((first, second) => first - second);
  const names = new Map(kept.map((id, index) => [id, functionName(index, module.functions[id].name)] as const));
  const nameOf = (id: number): string => {
    const name = names.get(representative.get(target(id)) ?? -1);
    if (name === undefined) throw new Error(`The validator compiler has no emitted function for the schema function ${id}.`);
    return name;
  };
  // Second pass: only the functions that stay, so the constants and helpers are those they use.
  const state = new ModuleState();
  state.importValidations(module.validations);
  const functions = kept.map(id => {
    const { parameters, body } = writeFunction(state, module, target, module.functions[id]);
    return `function ${names.get(id)}(${parameters}) {\n${body.replace(FUNCTION_MARK, (_, called: string) => nameOf(Number(called)))}`;
  });
  const exported = exportNames(module.exports.map(({ name }) => name));
  const wrappers = module.exports.map(({ name, fn }) => [
    options.typed
      ? `export function ${exported.get(name)}(value: unknown, all: boolean): readonly SchemaIssue[] {`
      : `export function ${exported.get(name)}(value, all) {`,
    '  const issues = [];',
    `  ${callFunction(module.functions[target(fn)], nameOf(fn), { value: 'value', path: '[]', issues: 'issues', all: 'all' })};`,
    '  return issues;',
    '}',
  ].join('\n'));
  return [
    ...(options.typed ? [`import type { SchemaIssue } from ${literal(options.runtimeModule)};`] : []),
    ...state.prelude(options.runtimeModule),
    ...functions,
    ...wrappers,
    '',
  ].join('\n');
}
