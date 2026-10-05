import type { IrArray, IrCheck, IrFunction, IrModule, IrNumber, IrObject, IrSchema, IrString, IrTypeName, IrUnion } from './ir.js';

export interface EmitOptions {
  /** The module specifier the generated file imports its runtime helpers from. */
  readonly runtimeModule: string;
}

type RuntimeHelper = 'checkFormat' | 'codePointLength' | 'jsonEqual';
type LocalHelper = 'hasOwn' | 'isObject' | 'isMultipleOf';

// Parameters of every generated function: the value, the path stack, the issue list and the all-errors flag.
// Every call and header goes through `functionName`, `functionHeader` and `callFunction`, so a change to the
// parameter list is made in one place.
const VALUE = 'v';
const PATH = 'p';
const ISSUES = 'i';
const ALL = 'a';

function functionName(id: number): string {
  return `f${id}`;
}

function functionHeader(id: number): string {
  return `function ${functionName(id)}(${[VALUE, PATH, ISSUES, ALL].join(', ')}) {`;
}

function callFunction(id: number, args: { readonly value: string; readonly path?: string; readonly issues: string; readonly all: string }): string {
  return `${functionName(id)}(${[args.value, args.path ?? PATH, args.issues, args.all].join(', ')})`;
}

const LOCAL_HELPERS: Readonly<Record<LocalHelper, string>> = {
  hasOwn: 'const hasOwn = Object.prototype.hasOwnProperty;',
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
};

const TYPE_TESTS: Readonly<Record<IrTypeName, (value: string) => string>> = {
  string: value => `typeof ${value} === 'string'`,
  number: value => `typeof ${value} === 'number'`,
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

  public runtimeHelper(name: RuntimeHelper): string {
    this.runtime.add(name);
    return name;
  }

  public localHelper(name: LocalHelper): string {
    this.helpers.add(name);
    return name;
  }

  /** Declares a module-level constant and returns its name. */
  public constant(prefix: string, expression: string): string {
    const name = `${prefix}${this.declarations.length}`;
    this.declarations.push(`const ${name} = ${expression};`);
    return name;
  }

  public prelude(runtimeModule: string): string[] {
    const lines: string[] = [];
    if (this.runtime.size > 0) lines.push(`import { ${[...this.runtime].sort().join(', ')} } from ${literal(runtimeModule)};`);
    for (const name of Object.keys(LOCAL_HELPERS) as LocalHelper[]) if (this.helpers.has(name)) lines.push(LOCAL_HELPERS[name]);
    return [...lines, ...this.declarations];
  }
}

/** Writes one function. A failed check pushes its issue, then returns at once unless all errors are wanted. */
class FunctionWriter {
  private readonly lines: string[] = [];
  private depth = 1;
  private counter = 0;

  public constructor(private readonly state: ModuleState) {}

  public write(fn: IrFunction): string {
    this.lines.push(functionHeader(fn.id));
    this.line(`const pl = ${PATH}.length;`);
    this.line('let ok = true;');
    this.schema(fn.body, VALUE);
    this.line('return ok;');
    this.lines.push('}');
    return this.lines.join('\n');
  }

  private line(text: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}${text}`);
  }

  private open(head: string): void {
    this.line(`${head} {`);
    this.depth++;
  }

  private close(): void {
    this.depth--;
    this.line('}');
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

  private limitIssue(code: 'tooSmall' | 'tooBig', measure: string, limit: number, inclusive: boolean): void {
    this.issue(`code: ${literal(code)}, measure: ${literal(measure)}, limit: ${JSON.stringify(limit)}, inclusive: ${inclusive}`);
  }

  private schema(schema: IrSchema, value: string): void {
    if (schema.kind === 'never') this.issue("code: 'never'");
    else if (schema.kind === 'checks') for (const check of schema.checks) this.check(check, value);
  }

  /** Runs `body` for the child `token` of the current value with the path extended. */
  private atChild(token: string, body: () => void): void {
    this.line(`${PATH}.push(${token});`);
    body();
    this.line(`${PATH}.pop();`);
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
        const values = this.state.constant('lit', `JSON.parse(${literal(JSON.stringify(check.values))})`);
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
      case 'string': return this.stringCheck(check, value);
      case 'number': return this.numberCheck(check, value);
      case 'array': return this.arrayCheck(check, value);
      case 'object': return this.objectCheck(check, value);
      case 'call':
        this.open(`if (!${callFunction(check.fn, { value, issues: ISSUES, all: ALL })})`);
        this.fail();
        this.close();
        return;
      case 'allOf':
        for (const branch of check.branches) this.schema(branch, value);
        return;
      case 'union': return this.unionCheck(check, value);
      case 'not':
        this.open(`if (${callFunction(check.fn, { value, issues: '[]', all: 'false' })})`);
        this.issue("code: 'not'");
        this.close();
        return;
    }
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
    this.open(`if (Array.isArray(${value}))`);
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
    check.prefixItems.forEach((schema, position) => {
      if (schema.kind === 'always') return;
      this.open(`if (${value}.length > ${position})`);
      const item = this.fresh('item');
      this.line(`const ${item} = ${value}[${position}];`);
      this.atChild(String(position), () => this.schema(schema, item));
      this.close();
    });
    if (check.items !== undefined && check.items.kind !== 'always') {
      const index = this.fresh('x');
      const item = this.fresh('item');
      const items = check.items;
      this.open(`for (let ${index} = ${check.prefixItems.length}; ${index} < ${value}.length; ${index}++)`);
      this.line(`const ${item} = ${value}[${index}];`);
      this.atChild(index, () => this.schema(items, item));
      this.close();
    }
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
    this.close();
  }

  private objectCheck(check: IrObject, value: string): void {
    this.state.localHelper('isObject');
    this.open(`if (isObject(${value}))`);
    const needsKeys = check.minProperties !== undefined || check.maxProperties !== undefined || check.additional !== undefined;
    const keys = this.fresh('keys');
    if (needsKeys) this.line(`const ${keys} = Object.keys(${value});`);
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
    const hasOwn = this.state.localHelper('hasOwn');
    for (const key of check.required) {
      this.open(`if (!${hasOwn}.call(${value}, ${literal(key)}))`);
      this.issue(`code: 'required', key: ${literal(key)}`, `[...${PATH}, ${literal(key)}]`);
      this.close();
    }
    for (const property of check.properties) {
      if (property.schema.kind === 'always') continue;
      const schema = property.schema;
      this.open(`if (${hasOwn}.call(${value}, ${literal(property.key)}))`);
      const member = this.fresh('member');
      this.line(`const ${member} = ${value}[${literal(property.key)}];`);
      this.atChild(literal(property.key), () => this.schema(schema, member));
      this.close();
    }
    if (check.additional) {
      const additional = check.additional;
      const known = this.state.constant('known', `new Set(${JSON.stringify(check.properties.map(property => property.key))})`);
      const key = this.fresh('key');
      this.open(`for (const ${key} of ${keys})`);
      this.line(`if (${known}.has(${key})) continue;`);
      if (additional.kind === 'forbid') {
        this.issue(`code: 'unknownKey', key: ${key}`, `[...${PATH}, ${key}]`);
      } else {
        const member = this.fresh('member');
        this.line(`const ${member} = ${value}[${key}];`);
        this.atChild(key, () => this.schema(additional.schema, member));
      }
      this.close();
    }
    this.close();
  }

  private unionCheck(check: IrUnion, value: string): void {
    const attempt = (fn: number): string => callFunction(fn, { value, issues: '[]', all: 'false' });
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
}

/** The name of the exported wrapper for the root at `index`; any character that is not valid in a name becomes `_`. */
function wrapperName(name: string, index: number): string {
  return `validate_${name.replace(/[^A-Za-z0-9_$]/g, '_')}_${index}`;
}

/** Emits the module: one function per IR function, one wrapper per root, and `export const validators`. */
export function emit(module: IrModule, options: EmitOptions): string {
  const state = new ModuleState();
  const functions = module.functions.map(fn => new FunctionWriter(state).write(fn));
  const wrappers = module.exports.map(({ fn }, index) => [
    `function ${wrapperName(module.exports[index].name, index)}(value, all) {`,
    '  const issues = [];',
    `  ${callFunction(fn, { value: 'value', path: '[]', issues: 'issues', all: 'all' })};`,
    '  return issues;',
    '}',
  ].join('\n'));
  const entries = module.exports.map(({ name }, index) => `  [${literal(name)}]: ${wrapperName(name, index)},`);
  return [
    '// Generated by golem. Do not edit.',
    ...state.prelude(options.runtimeModule),
    ...functions,
    ...wrappers,
    ['export const validators = {', ...entries, '};'].join('\n'),
    '',
  ].join('\n');
}
