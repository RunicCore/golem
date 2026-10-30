import { code, identifier as identifierCode, join, joinIndented, literal as literalCode, type Code, type IndentedLine } from '../code.js';
import type { IrArray, IrCheck, IrClass, IrDiscriminator, IrFunction, IrInstance, IrNumber, IrObject, IrPatternProperty, IrSchema, IrString, IrType, IrTypeName, IrUnion, IrValidation, IrValidationImport } from './ir.js';
import { rt, runtimeFunctionCode } from '../rt.js';
import { presentValueCode } from '../union-conversion.js';
import { VALUE, PATH, NEWLINE, COMMA, ISSUES, ALL, SANITY, INHERITED, EVALUATION, type CalleeSlot, type CallArguments } from './function-names.js';
import { isTuple, keepsFormat } from './call-graph.js';
import { JSON_TYPES, dispatchTest } from './json-types.js';
import { localName, lazyStateTest, scaledDivisor } from './local-helpers.js';
import { patternExpression, type ModuleState } from './module-state.js';
import { resolve, readSet, objectPresence, type Capture, type Lazy, type KeyTest, type WriterMode } from './modes.js';

const runtime = rt['validation-runtime'];

const objectTest = JSON_TYPES.object.code;

/** The model class of `value` among the codec ids `among`, which the module keeps as one frozen list. */
function selectedModelCall(state: ModuleState, value: Code, among: readonly string[]): Code {
  return code`${localName('selectedModel')}(${value}, ${state.constant('models', code`Object.freeze(${literalCode(among)})`, JSON.stringify(among))})`;
}

/** A leaf check: the expression that is true when the value fails it, and the issue it then reports. */
interface LeafCheck {
  readonly fails: Lazy;
  /** The same test written cheaper for the fast check, where the full validator's form costs more than the verdict needs. */
  readonly fast?: Lazy;
  /** The fields of the issue after its path. */
  readonly issue: Lazy;
  /** The path of the issue; the current path by default. */
  readonly path?: Code;
  /**
   * The sanity level does not run this check. `cheap`: the test is a comparison, so a value that passes it pays nothing
   * for the flag (`test && !s`). `costly`: the test costs more than the flag (`!s && test`).
   */
  readonly skip?: 'cheap' | 'costly';
}

/** The type names of every JSON value, which a hole in an array is none of. */
const JSON_TYPE_NAMES: readonly IrTypeName[] = ['null', 'boolean', 'number', 'string', 'array', 'object'];

/** The issue fields of a limit; `limit` is a number, or an expression of the generated code. */
function limitFields(kind: 'tooSmall' | 'tooBig', measure: string, limit: number | Code, inclusive: boolean): Code {
  return code`code: ${literalCode(kind)}, measure: ${literalCode(measure)}, limit: ${typeof limit === 'number' ? literalCode(limit) : limit}, inclusive: ${literalCode(inclusive)}`;
}

/** A value of JSON that `===` compares as `jsonEqual` does. */
function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** What the passes of one object check share: its key test, and the patterns of `patternProperties` with their expressions. */
interface ObjectPass {
  readonly check: IrObject;
  readonly value: Code;
  /** The function keeps an evaluation record, so a check that accepts anything still marks its key. */
  readonly marks: boolean;
  readonly test: KeyTest;
  readonly patterns: readonly { readonly entry: IrPatternProperty; readonly expression: Code }[];
  /** The patterns whose checks run. */
  readonly patternsToRun: readonly { readonly entry: IrPatternProperty; readonly expression: Code }[];
}

/** The key list or count that the key test made for a check that reads it. */
function keyList(what: Code | undefined): Code {
  if (what === undefined) throw new Error('The key test of this validator mode left no key list or count for an object check that reads it.');
  return what;
}

/** Writes one function in the given mode: the mode decides what a failed check writes and how a declared key is read. */
export class FunctionWriter {
  private readonly lines: IndentedLine[] = [];
  private depth = 1;
  private counter = 0;
  /** The record that checks of the value being checked fill; undefined when this function keeps none, or while a child value is checked. */
  private record: Code | undefined;

  /** The full validators this one calls, by the id they have after forwarding. */
  public readonly calls = new Set<number>();
  /** The fast checks this one calls, by the id they have after forwarding. */
  public readonly fastCalls = new Set<number>();
  /** The branch functions of the tagged unions being written in place now; a branch in it is called, not written in place again (see `mergedBranches`). */
  private readonly merging = new Set<number>();

  public constructor(
    public readonly state: ModuleState,
    public readonly functions: readonly IrFunction[],
    private readonly validations: readonly IrValidationImport[],
    public readonly target: (id: number) => number,
    private readonly fn: IrFunction,
    private mode: WriterMode,
    public readonly calleeSlot: CalleeSlot,
  ) {
    // The record travels through the full validators' arguments, so a function that keeps or receives one is a leaf of the fast check.
    if (!mode.records && (fn.collects || fn.receives)) throw new Error(`The validator compiler writes no fast check for the schema function ${fn.id}: it keeps or receives an evaluation record.`);
    this.record = fn.collects || fn.receives ? EVALUATION : undefined;
  }

  /** The body of the function, without its header line. */
  public write(): Code {
    for (const start of this.mode.fail.start) this.line(start);
    if (this.fn.collects) this.line(code`const ${EVALUATION} = ${localName('newEvaluation')}();`);
    else if (this.fn.receives) this.line(code`const ${EVALUATION} = ${INHERITED} ?? ${localName('newEvaluation')}();`);
    this.schema(this.fn.body, VALUE);
    // A function that both keeps a record and receives one hands what it evaluated to its caller once it passed.
    if (this.fn.collects && this.fn.receives) this.line(code`if (ok && ${INHERITED} !== undefined) ${localName('mergeEvaluation')}(${INHERITED}, ${EVALUATION});`);
    // A `false` schema has already left the function in a mode that leaves at a failure.
    if (this.fn.body.kind !== 'never' || !this.mode.fail.leaves) this.line(this.mode.fail.end);
    this.lines.push({ spaces: 0, body: code`}` });
    return joinIndented(this.lines, NEWLINE);
  }

  public line(statement: Code): void {
    this.lines.push({ spaces: this.depth * 2, body: statement });
  }

  /** Opens a block; no `head` opens a bare scope. */
  public open(head?: Code): void {
    this.line(head === undefined ? code`{` : code`${head} {`);
    this.depth++;
  }

  public close(): void {
    this.depth--;
    this.line(code`}`);
  }

  /** A block that is left out when `body` writes nothing, as when a check only marks what it evaluates and nothing reads the mark. */
  private block(head: Code, body: () => void): void {
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

  /**
   * Writes `body` under the guard `head`, or without it when the value already has one of the types `guardTypes` that
   * the guard tests for: a type check before it left the function on any other type. `dropsEmpty` leaves out a guard
   * whose body writes nothing, as `block` does.
   */
  private guarded(head: Code, guardTypes: readonly IrTypeName[], types: readonly IrTypeName[] | undefined, body: () => void, dropsEmpty: boolean): void {
    if (types !== undefined && types.every(name => guardTypes.includes(name))) return body();
    if (dropsEmpty) return this.block(head, body);
    this.open(head);
    body();
    this.close();
  }

  public fresh(prefix: string): Code {
    return identifierCode(`${prefix}${this.counter++}`);
  }

  /** A failed check with the issue `fields` at `path` (the current path by default), as the mode writes it. */
  private issue(fields: Code, path: Code = code`${PATH}.slice()`): void {
    for (const statement of this.mode.fail.issue(fields, path)) this.line(statement);
  }

  /** A failed check whose issue a callee already reported, as the mode writes it. */
  private fail(): void {
    this.line(this.mode.fail.fail());
  }

  /** Fails the function when `test` holds, where a callee already reported the issue, or the mode builds none. */
  public failWhen(test: Code): void {
    if (this.mode.fail.leaves) return this.line(code`if (${test}) ${this.mode.fail.fail()}`);
    this.open(code`if (${test})`);
    this.fail();
    this.close();
  }

  /** True when this function takes the sanity flag `s` and its mode honors it: a skipped check is written under the flag. */
  private get honorsSanity(): boolean {
    return this.mode.takesSanity && this.fn.sanity === true;
  }

  /** True when this function honors the flag and a function in `ids` reaches a check the sanity level skips: the check that calls them is relaxed there. */
  private relaxes(ids: readonly number[]): boolean {
    return this.honorsSanity && ids.some(id => this.functions[this.target(id)].sanity === true);
  }

  /** Writes `body` where the sanity level does not run it. */
  private unlessSanity(body: () => void): void {
    if (!this.honorsSanity) return body();
    this.open(code`if (!${SANITY})`);
    body();
    this.close();
  }

  private leaf(check: LeafCheck): void {
    const test = resolve(this.mode.form(check.fails, check.fast));
    const failing = check.skip === undefined || !this.honorsSanity ? test : check.skip === 'cheap' ? code`(${test}) && !${SANITY}` : code`!${SANITY} && (${test})`;
    if (this.mode.fail.leaves) return this.failWhen(failing);
    this.open(code`if (${failing})`);
    this.issue(resolve(check.issue), check.path);
    this.close();
  }

  /** The `tooSmall` and `tooBig` leaves of a lower and an upper limit on `measure`, whose value `actual` holds; `fast` writes each test cheaper. */
  private limitLeaves(measure: string, actual: Lazy, min: number | undefined, max: number | undefined, fast?: { readonly min: (limit: number) => Code; readonly max: (limit: number) => Code }, skip?: LeafCheck['skip']): void {
    if (min !== undefined) this.leaf({ fails: () => code`${resolve(actual)} < ${literalCode(min)}`, ...(fast ? { fast: () => fast.min(min) } : {}), issue: limitFields('tooSmall', measure, min, true), ...(skip ? { skip } : {}) });
    if (max !== undefined) this.leaf({ fails: () => code`${resolve(actual)} > ${literalCode(max)}`, ...(fast ? { fast: () => fast.max(max) } : {}), issue: limitFields('tooBig', measure, max, true), ...(skip ? { skip } : {}) });
  }

  /** Adds a statement that marks what the current value evaluated, when this function keeps a record. */
  private mark(statement: (record: Code) => Code): void {
    if (this.record !== undefined) this.line(statement(this.record));
  }

  private requireRecord(): Code {
    if (this.record === undefined) throw new Error('A check that reads evaluated keys or items needs a function that keeps a record.');
    return this.record;
  }

  private call(id: number, args: CallArguments): Code {
    return this.mode.call(this, id, args);
  }

  /** The function `id` applies to the same value in place: it fails this function when it fails, and fills this function's record. */
  private callInPlace(id: number, value: Code): void {
    this.failWhen(code`!${this.call(id, { value, issues: ISSUES, all: ALL, ...(this.record === undefined ? {} : { record: this.record }) })}`);
  }

  public schema(schema: IrSchema, value: Code): void {
    if (schema.kind === 'never') this.issue(code`code: 'never'`);
    else if (schema.kind === 'checks') this.checks(schema.checks, value);
  }

  private checks(checks: readonly IrCheck[], value: Code): void {
    // In a mode that leaves at a failure, the checks after a type check run only on a value of its types.
    let types: readonly IrTypeName[] | undefined;
    for (let position = 0; position < checks.length; position++) {
      const check = checks[position];
      const next = checks[position + 1];
      // A value that is not an object has already failed the type check, so the object keywords have nothing to test.
      if (check.kind === 'type' && check.names.every(name => name === 'object') && next?.kind === 'object') {
        this.objectOrTypeIssue(check, next, value);
        position++;
      } else {
        this.check(check, value, types);
      }
      if (check.kind === 'type' && this.mode.fail.leaves) types = check.names;
    }
  }

  /** Runs `body` for the child `token` of the current value, as the mode writes a child; the child has its own evaluation, so no record is filled. */
  public atChild(token: Code, body: () => void): void {
    const record = this.record;
    this.record = undefined;
    this.mode.child(this, token, body);
    this.record = record;
  }

  /** `types`, when given, lists the types the value already has: a guard on one of them is not written again. */
  private check(check: IrCheck, value: Code, types?: readonly IrTypeName[]): void {
    switch (check.kind) {
      case 'type':
        return this.leaf({ fails: code`!(${join(check.names.map(name => JSON_TYPES[name].code(value)), code` || `)})`, issue: code`code: 'type', expected: ${literalCode(check.names)}` });
      case 'literal': {
        const values = (): Code => this.state.constant('lit', code`Object.freeze(/*#__PURE__*/ JSON.parse(${literalCode(JSON.stringify(check.values))}))`, JSON.stringify(check.values));
        const equal = (item: Code): Code => code`${runtime.jsonEqual}(${value}, ${item})`;
        return this.leaf({
          fails: () => (check.values.length === 1 ? code`!${equal(code`${values()}[0]`)}` : code`!${values()}.some(item => ${equal(code`item`)})`),
          // `jsonEqual` starts with `===`, and a JSON primitive equals nothing else, so `===` decides for a primitive.
          // An empty `enum` allows no value.
          fast: () => (check.values.length === 0 ? code`true` : join(check.values.map((item, position) => (isPrimitive(item) ? code`${value} !== ${literalCode(item)}` : code`!${equal(code`${values()}[${literalCode(position)}]`)}`)), code` && `)),
          issue: () => code`code: 'literal', expected: ${values()}`,
        });
      }
      case 'format':
        return this.leaf({
          fails: () => code`!${runtime.checkFormat}(${literalCode(check.format)}, ${value})`,
          // The format's test, looked up once when the module loads.
          fast: () => code`!${this.state.constant('format', code`${runtime.formatTest}(${literalCode(check.format)})`, check.format)}(${value})`,
          issue: code`code: 'format', format: ${literalCode(check.format)}`,
          ...(keepsFormat(check.format) ? {} : { skip: 'costly' as const }),
        });
      case 'class': return this.classCheck(check, value);
      case 'instance': return this.instanceCheck(check, value);
      case 'validation': return this.validationCheck(check, value);
      case 'string': return this.stringCheck(check, value, types);
      case 'number': return this.numberCheck(check, value, types);
      case 'array': return this.arrayCheck(check, value, types);
      case 'object': return this.objectCheck(check, value, types);
      case 'call': return this.callInPlace(check.fn, value);
      case 'allOf':
        for (const branch of check.branches) this.schema(branch, value);
        return;
      case 'union': return check.discriminator ? this.discriminatedUnion(check, check.discriminator, value) : this.unionCheck(check, value);
      case 'not':
        // The sanity level does not run a `not` whose schema reaches a skipped check: that check passing less would fail the `not` more.
        return this.leaf({ fails: this.call(check.fn, { value, issues: code`[]`, all: code`false` }), issue: code`code: 'not'`, ...(this.relaxes([check.fn]) ? { skip: 'costly' as const } : {}) });
      case 'conditional': return this.conditionalCheck(check, value);
      case 'dependentSchemas': {
        const presence = objectPresence(value);
        this.open(code`if (${localName('isObject')}(${value}))`);
        for (const { trigger, fn } of check.entries) {
          this.open(code`if (${presence.present(trigger)})`);
          this.callInPlace(fn, value);
          this.close();
        }
        this.close();
        return;
      }
      case 'unevaluatedProperties': return this.unevaluatedProperties(check.schema, value);
      case 'unevaluatedItems': return this.unevaluatedItems(check.schema, value);
      default: {
        // A new kind of check fails the build here, and generation, instead of being skipped.
        const unwritten: never = check;
        throw new Error(`The validator compiler writes no check of the kind ${JSON.stringify(unwritten)}.`);
      }
    }
  }

  /** An imported class is tested by `instanceof`; a global one by a test that looks the class up at each call, so a missing polyfill gives an issue. */
  private classCheck(check: IrClass, value: Code): void {
    const issue = code`code: 'instance', model: ${literalCode(check.name)}`;
    if (check.from === undefined) {
      const valid = check.valid === undefined ? code`` : code`, ${runtimeFunctionCode(check.valid)}`;
      const test = this.state.constant('global', code`${runtime.globalInstanceTest}(${literalCode(check.path)}${valid})`, [...check.path, check.valid?.id ?? ''].join('\u0000'));
      return this.leaf({ fails: code`!${test}(${value})`, issue });
    }
    const imported = join([this.state.validationFunction(check.from), ...check.path.map(identifierCode)], code`.`);
    this.leaf({ fails: code`!(${value} instanceof ${imported})`, issue });
  }

  /** The class the value's encoder selects must be `of`; see `IrInstance`. */
  private instanceCheck(check: IrInstance, value: Code): void {
    const selected = this.fresh('selected');
    this.line(code`const ${selected} = ${selectedModelCall(this.state, value, check.among)};`);
    const expected = check.of === undefined ? code`undefined` : literalCode(check.of);
    this.leaf({
      fails: check.required || check.of === undefined ? code`${selected} !== ${expected}` : code`${selected} !== undefined && ${selected} !== ${expected}`,
      issue: code`code: 'instance', model: ${literalCode(check.of ?? check.among[0])}`,
    });
  }

  /** The functions run only after the structural schema passed, so they never see a value of the wrong shape. */
  private validationCheck(check: IrValidation, value: Code): void {
    // A function that reaches a validation function has no fast check, so the predicate runs once.
    if (!this.mode.records) throw new Error(`The validator compiler writes no fast check for the schema function ${this.fn.id}: it reaches a validation function.`);
    const runCalls = (): void => this.unlessSanity(() => {
      for (const index of check.calls) {
        const result = this.fresh('result');
        this.line(code`const ${result} = ${this.state.validationFunction(index)}(${value});`);
        this.open(code`if (typeof ${result} !== 'boolean' && typeof ${result} !== 'string')`);
        this.line(code`throw new TypeError(${literalCode(`Validation function ${this.validations[index]!.exportName} must return boolean or string.`)});`);
        this.close();
        this.leaf({ fails: code`${result} !== true`, issue: code`code: 'custom', ...(typeof ${result} === 'string' && ${result}.length > 0 ? { reason: ${result} } : {})` });
      }
    });
    if (check.fn === undefined) return runCalls();
    this.open(code`if (${this.call(check.fn, { value, issues: ISSUES, all: ALL, ...(this.record === undefined ? {} : { record: this.record }) })})`);
    if (check.calls.length > 0) runCalls();
    this.close();
    this.open(code`else`);
    this.fail();
    this.close();
  }

  private stringCheck(check: IrString, value: Code, types: readonly IrTypeName[] | undefined): void {
    this.guarded(code`if (typeof ${value} === 'string')`, ['string'], types, () => this.stringKeywords(check, value), false);
  }

  private stringKeywords(check: IrString, value: Code): void {
    // The full validator counts the code points once, in a local written before the first limit that reads it.
    let counted: Code | undefined;
    const length = (): Code => {
      if (counted === undefined) {
        counted = this.fresh('n');
        this.line(code`const ${counted} = ${runtime.codePointLength}(${value});`);
      }
      return counted;
    };
    // A code point is one or two UTF-16 units, so the fast check counts them only where the length cannot decide.
    const codePoints = (): Code => code`${runtime.codePointLength}(${value})`;
    // The count of code points costs a pass over the text, so the sanity level skips the lengths as a block.
    if (check.minLength !== undefined || check.maxLength !== undefined) {
      this.unlessSanity(() => this.limitLeaves('length', length, check.minLength, check.maxLength, {
        min: limit => code`${value}.length < ${literalCode(2 * limit)} && ${codePoints()} < ${literalCode(limit)}`,
        max: limit => code`${value}.length > ${literalCode(limit)} && ${codePoints()} > ${literalCode(limit)}`,
      }));
    }
    if (check.pattern !== undefined) {
      const expression = patternExpression(this.state, check.pattern);
      this.leaf({ fails: code`!${expression}.test(${value})`, issue: code`code: 'pattern', pattern: ${literalCode(check.pattern)}`, skip: 'costly' });
    }
  }

  private numberCheck(check: IrNumber, value: Code, types: readonly IrTypeName[] | undefined): void {
    this.guarded(code`if (typeof ${value} === 'number')`, ['number', 'integer'], types, () => this.numberKeywords(check, value), false);
  }

  private numberKeywords(check: IrNumber, value: Code): void {
    const bounds = [
      ['minimum', code`<`, 'tooSmall', true],
      ['exclusiveMinimum', code`<=`, 'tooSmall', false],
      ['maximum', code`>`, 'tooBig', true],
      ['exclusiveMaximum', code`>=`, 'tooBig', false],
    ] as const;
    for (const [keyword, operator, kind, inclusive] of bounds) {
      const limit = check[keyword];
      if (limit === undefined) continue;
      this.leaf({ fails: code`${value} ${operator} ${literalCode(limit)}`, issue: limitFields(kind, 'value', limit, inclusive), skip: 'cheap' });
    }
    if (check.multipleOf !== undefined) {
      const divisor = literalCode(check.multipleOf);
      const scaled = scaledDivisor(check.multipleOf);
      const test = scaled === undefined
        ? code`${localName('isMultipleOf')}(${value}, ${divisor})`
        : code`${localName('isMultipleOfScaled')}(${value}, ${divisor}, ${literalCode(scaled.units)}, ${literalCode(scaled.scale)})`;
      this.leaf({ fails: code`!${test}`, issue: code`code: 'multipleOf', divisor: ${divisor}`, skip: 'costly' });
    }
  }

  private arrayCheck(check: IrArray, value: Code, types: readonly IrTypeName[] | undefined): void {
    this.guarded(code`if (Array.isArray(${value}))`, ['array'], types, () => {
      // A tuple's arity is shape; any other count of items is a limit.
      this.limitLeaves('items', code`${value}.length`, check.minItems, check.maxItems, undefined, isTuple(check) ? undefined : 'cheap');
      if (check.closed) this.leaf({ fails: code`${value}.length > ${literalCode(check.prefixItems.length)}`, issue: limitFields('tooBig', 'items', check.prefixItems.length, true) });
      if (check.prefixItems.length > 0) this.mark(record => code`${record}.prefix = Math.max(${record}.prefix, Math.min(${value}.length, ${literalCode(check.prefixItems.length)}));`);
      // The JSON view of an item: an `undefined` item is `null`, and a hole is no JSON value (one `type` issue; its schema is skipped).
      check.prefixItems.forEach((schema, position) => {
        this.open(code`if (${value}.length > ${literalCode(position)})`);
        this.arrayItem(literalCode(position), value, schema.kind === 'always' ? undefined : schema);
        this.close();
      });
      if (check.items !== undefined || check.closed) this.mark(record => code`${record}.allItems = true;`);
      // The loop over the items checks for holes too, so a valid array is walked once; an array check with no such loop gets one.
      const index = this.fresh('x');
      this.open(code`for (let ${index} = ${literalCode(check.prefixItems.length)}; ${index} < ${value}.length; ${index}++)`);
      this.arrayItem(index, value, check.items !== undefined && check.items.kind !== 'always' ? check.items : undefined);
      this.close();
      if (check.contains !== undefined) this.containsCheck(check.contains, value);
      if (check.uniqueItems) this.unlessSanity(() => {
        const first = this.fresh('x');
        const second = this.fresh('y');
        // With all errors the search stops at the first duplicate pair; a mode that leaves at a failure needs no label.
        const label = this.mode.fail.leaves ? undefined : this.fresh('unique');
        this.open(code`${label === undefined ? code`` : code`${label}: `}for (let ${first} = 0; ${first} < ${value}.length - 1; ${first}++)`);
        this.open(code`for (let ${second} = ${first} + 1; ${second} < ${value}.length; ${second}++)`);
        // An `undefined` item is `null` in the JSON view, as in every array keyword and as `jsonEqual` reads nested items.
        this.open(code`if (${runtime.jsonEqual}(${value}[${first}] ?? null, ${value}[${second}] ?? null))`);
        this.issue(code`code: 'unique', indexes: [${first}, ${second}]`);
        if (label !== undefined) this.line(code`break ${label};`);
        this.close();
        this.close();
        this.close();
      });
    }, true);
  }

  /**
   * The item of `value` at `index`, checked against `schema`: a hole is one `type` issue and skips the schema, and an
   * `undefined` item is read as `null`. A valid item costs one comparison with `undefined`; the `in` test runs for an
   * `undefined` item only. Without a schema, the hole test is all there is.
   */
  private arrayItem(index: Code, value: Code, schema: IrSchema | undefined): void {
    const hole = code`!(${index} in ${value})`;
    const issue = code`code: 'type', expected: ${literalCode(JSON_TYPE_NAMES)}`;
    if (schema === undefined) {
      // The path is pushed for the issue only.
      const fails = code`${value}[${index}] === undefined && ${hole}`;
      if (this.mode.fail.leaves) return this.failWhen(fails);
      this.open(code`if (${fails})`);
      this.atChild(index, () => this.issue(issue));
      this.close();
      return;
    }
    this.atChild(index, () => {
      const item = this.fresh('item');
      this.line(code`let ${item} = ${value}[${index}];`);
      // A mode that leaves at a failure has left at the hole; the full validator goes on in all-errors mode, so it jumps past the schema.
      const skip = this.mode.fail.leaves ? undefined : this.fresh('skip');
      if (skip !== undefined) this.open(code`${skip}:`);
      this.open(code`if (${item} === undefined)`);
      if (skip === undefined) {
        this.leaf({ fails: hole, issue });
      } else {
        this.open(code`if (${hole})`);
        this.issue(issue);
        this.line(code`break ${skip};`);
        this.close();
      }
      this.line(code`${item} = null;`);
      this.close();
      this.schema(schema, item);
      if (skip !== undefined) this.close();
    });
  }

  /**
   * Counts the items that pass `contains`; the count must lie between its limits, and each match counts as evaluated.
   * The sanity level needs one match at most, and none when `contains` reaches a skipped check (the count would
   * fail more once that check passes less); it still marks the matches for `unevaluatedItems`.
   */
  private containsCheck(contains: NonNullable<IrArray['contains']>, value: Code): void {
    const marks = this.record !== undefined;
    if (contains.min === 0 && contains.max === undefined && !marks) return;
    const relaxed = this.relaxes([contains.fn]);
    const write = (): void => {
      const count = this.fresh('count');
      const index = this.fresh('x');
      this.line(code`let ${count} = 0;`);
      this.open(code`for (let ${index} = 0; ${index} < ${value}.length; ${index}++)`);
      this.open(code`if (${this.call(contains.fn, { value: code`${value}[${index}] ?? null`, issues: code`[]`, all: code`false` })})`);
      this.line(code`${count}++;`);
      this.mark(record => code`${record}.indexes.add(${index});`);
      // Without a maximum or a record, the first `min` matches decide the outcome.
      if (contains.max === undefined && !marks) this.line(code`if (${count} >= ${literalCode(contains.min)}) break;`);
      this.close();
      this.close();
      // Inside the block of a `contains` that nothing marks, the sanity level has already left.
      const inBlock = relaxed && !marks;
      // A smaller minimum is a limit; one match is the least `contains` needs.
      const bound = !relaxed && contains.min > 1 && this.honorsSanity ? code`(${SANITY} ? 1 : ${literalCode(contains.min)})` : literalCode(contains.min);
      if (contains.min > 0) this.leaf({ fails: code`${count} < ${bound}`, issue: limitFields('tooSmall', 'matches', contains.min, true), ...(relaxed && !inBlock ? { skip: 'cheap' as const } : {}) });
      this.limitLeaves('matches', count, undefined, contains.max, undefined, inBlock ? undefined : 'cheap');
    };
    if (relaxed && !marks) this.unlessSanity(write);
    else write();
  }

  private objectCheck(check: IrObject, value: Code, types: readonly IrTypeName[] | undefined): void {
    this.guarded(code`if (${objectTest(value)})`, ['object'], types, () => this.objectKeywords(check, value), true);
  }

  /** The type check that requires an object, and the object keywords in its `else`: the value is tested once. */
  private objectOrTypeIssue(type: IrType, check: IrObject, value: Code): void {
    // A mode that leaves at a failure needs no `else`: the keywords follow the type test.
    if (this.mode.fail.leaves) {
      this.failWhen(code`!${objectTest(value)}`);
      return this.objectKeywords(check, value);
    }
    this.open(code`if (!${objectTest(value)})`);
    this.issue(code`code: 'type', expected: ${literalCode(type.names)}`);
    this.depth--;
    this.line(code`} else {`);
    this.depth++;
    const start = this.lines.length;
    this.objectKeywords(check, value);
    if (this.lines.length === start) {
      this.lines.pop();
      this.depth--;
      this.line(code`}`);
    } else {
      this.close();
    }
  }

  /** `prepared` is the key test a caller already wrote for this object; without it the mode's key test is written here. */
  private objectKeywords(check: IrObject, value: Code, prepared?: KeyTest): void {
    const marks = this.record !== undefined;
    const reads = readSet(check, marks);
    const captured = reads.declared.map(key => [key, this.fresh('present')] as const);
    // A key that matches a pattern is not "additional" even when the pattern's schema accepts everything.
    const patterns = check.patternProperties.map(entry => ({ entry, expression: patternExpression(this.state, entry.pattern) }));
    const test = prepared ?? this.mode.keyTest(this, { check, value, captured, reads });
    const pass: ObjectPass = { check, value, marks, test, patterns, patternsToRun: patterns.filter(({ entry }) => reads.patterns.includes(entry)) };
    this.limitLeaves('properties', () => keyList(test.count), check.minProperties, check.maxProperties, undefined, 'cheap');
    this.requiredKeys(pass);
    // Ahead of `properties`: with fail-fast the first issue is the object's own unknown key. A key test that made `unknown` ran it.
    if (test.unknown !== undefined) this.failWhen(test.unknown);
    // The passes below fail only after the values are read, which the key test left to them.
    const outer = this.mode;
    // A failure of the passes reads this object's values, then fails as the enclosing object does, which reads its own.
    if (test.failure !== undefined) {
      const chained = code`{ ${test.failure} ${outer.fail.fail()} }`;
      this.mode = { ...outer, fail: { ...outer.fail, issue: () => [chained], fail: () => chained } };
    }
    if (check.additional && reads.visitsAdditional && test.keys !== undefined && test.unknown === undefined) this.additionalKeys(pass, check.additional, test.keys);
    this.declaredProperties(pass);
    if (pass.patternsToRun.length > 0) this.patternKeys(pass);
    // `additionalProperties` takes every key the other two did not.
    if (check.additional !== undefined) this.mark(record => code`${record}.allKeys = true;`);
    if (check.propertyNames !== undefined) this.propertyNames(pass, check.propertyNames);
    this.mode = outer;
  }

  /** `required` and `dependentRequired`. */
  private requiredKeys({ check, test: { presence } }: ObjectPass): void {
    const required = (key: string): LeafCheck => ({ fails: code`!${presence.present(key)}`, issue: code`code: 'required', key: ${literalCode(key)}`, path: code`[...${PATH}, ${literalCode(key)}]` });
    for (const key of check.required) this.leaf(required(key));
    for (const { trigger, keys: dependents } of check.dependentRequired) {
      if (dependents.length === 0) continue;
      this.open(code`if (${presence.present(trigger)})`);
      for (const key of dependents) this.leaf(required(key));
      this.close();
    }
  }

  /** The keys that neither `properties` nor `patternProperties` name: `additionalProperties`. */
  private additionalKeys({ check, value, patterns, test: { undefinedToo, failure } }: ObjectPass, additional: NonNullable<IrObject['additional']>, keys: Code): void {
    const key = this.fresh('key');
    const known = check.properties.length > 0 ? this.state.constant('known', code`new Set(${literalCode(check.properties.map(property => property.key))})`, JSON.stringify([...new Set(check.properties.map(property => property.key))].sort())) : undefined;
    const skipped = [...(known === undefined ? [] : [code`${known}.has(${key})`]), ...patterns.map(({ expression }) => code`${expression}.test(${key})`)];
    // A key that the instance's own model does not declare is program state: no unknown key, no value to judge.
    const fields = this.fresh('fields');
    this.line(code`let ${fields};`);
    this.open(code`for (const ${key} of ${keys})`);
    // A key test that left the values unread has this pass read each one, also of a key it then skips.
    const member = this.fresh('member');
    if (failure !== undefined) {
      this.line(code`const ${member} = ${value}[${key}];`);
      this.line(code`if (${member} === undefined) continue;`);
    }
    if (skipped.length > 0) this.line(code`if (${join(skipped, code` || `)}) continue;`);
    this.line(code`if (${lazyStateTest(fields, value, key, localName('instanceFields'))}) continue;`);
    if (additional.kind === 'forbid') {
      this.issue(code`code: 'unknownKey', key: ${key}`, code`[...${PATH}, ${key}]`);
    } else {
      const schema = additional.schema;
      if (failure === undefined) {
        this.line(code`const ${member} = ${value}[${key}];`);
        if (undefinedToo) this.line(code`if (${member} === undefined) continue;`);
      }
      this.atChild(key, () => this.schema(schema, member));
    }
    this.close();
  }

  /** `properties`: each declared key that is present, checked against its schema. */
  private declaredProperties({ check, marks, test: { presence } }: ObjectPass): void {
    // In a mode that leaves at a failure, a required key is present once its check passed.
    const present = new Set(this.mode.fail.leaves ? check.required : []);
    for (const property of check.properties) {
      if (property.schema.kind === 'always' && !marks) continue;
      const schema = property.schema;
      const guarded = !present.has(property.key);
      if (guarded) this.open(code`if (${presence.present(property.key)})`);
      this.mark(record => code`${record}.keys.add(${literalCode(property.key)});`);
      if (schema.kind !== 'always') {
        const member = this.fresh('member');
        this.line(code`const ${member} = ${presence.read(property.key)};`);
        this.atChild(literalCode(property.key), () => this.schema(schema, member));
      }
      if (guarded) this.close();
    }
  }

  /** `patternProperties`: each key a pattern matches, checked against the schema of the pattern. */
  private patternKeys({ value, patternsToRun, test: { keys, undefinedToo } }: ObjectPass): void {
    const fields = this.fresh('fields');
    this.line(code`let ${fields};`);
    const key = this.fresh('key');
    this.open(code`for (const ${key} of ${keyList(keys)})`);
    // A key list that also holds the keys whose value is `undefined` (`undefinedToo`) is read once, and those keys are left out.
    const held = undefinedToo ? this.fresh('member') : undefined;
    if (held !== undefined) {
      this.line(code`const ${held} = ${value}[${key}];`);
      this.line(code`if (${held} === undefined) continue;`);
    }
    for (const { entry, expression } of patternsToRun) {
      this.open(code`if (${expression}.test(${key}))`);
      // Program state is no property to judge, and it is not evaluated.
      this.line(code`if (${lazyStateTest(fields, value, key, localName('instanceFields'))}) continue;`);
      this.mark(record => code`${record}.keys.add(${key});`);
      if (entry.schema.kind !== 'always') {
        const schema = entry.schema;
        const member = held ?? this.fresh('member');
        if (held === undefined) this.line(code`const ${member} = ${value}[${key}];`);
        this.atChild(key, () => this.schema(schema, member));
      }
      this.close();
    }
    this.close();
  }

  /** `propertyNames`: each key, checked as a value of its own. */
  private propertyNames({ value, test: { keys, undefinedToo } }: ObjectPass, names: number): void {
    const key = this.fresh('key');
    this.open(code`for (const ${key} of ${keyList(keys)})`);
    if (undefinedToo) this.line(code`if (${value}[${key}] === undefined) continue;`);
    // A name that the instance's own model does not declare is program state, not a property name to judge.
    this.leaf({ fails: code`!${this.call(names, { value: key, issues: code`[]`, all: code`false` })} && !${localName('isInstanceState')}(${value}, ${key})`, issue: code`code: 'invalidKey', key: ${key}` });
    this.close();
  }

  /** `unevaluatedProperties`: the keys that nothing evaluated. */
  private unevaluatedProperties(schema: IrSchema, value: Code): void {
    const record = this.requireRecord();
    this.open(code`if (${localName('isObject')}(${value}))`);
    if (schema.kind !== 'always') {
      const key = this.fresh('key');
      this.open(code`if (!${record}.allKeys)`);
      this.open(code`for (const ${key} of ${localName('definedKeys')}(${value}))`);
      this.line(code`if (${record}.keys.has(${key})) continue;`);
      // Program state of a model instance is no unevaluated key, whether the schema forbids it or judges its value.
      this.line(code`if (${localName('isInstanceState')}(${value}, ${key})) continue;`);
      if (schema.kind === 'never') {
        this.issue(code`code: 'unknownKey', key: ${key}`, code`[...${PATH}, ${key}]`);
      } else {
        const member = this.fresh('member');
        this.line(code`const ${member} = ${value}[${key}];`);
        this.atChild(key, () => this.schema(schema, member));
      }
      this.close();
      this.close();
    }
    this.line(code`${record}.allKeys = true;`);
    this.close();
  }

  /** `unevaluatedItems`: the items that nothing evaluated. `false` gives one `tooBig` issue with the number of evaluated items as the limit. */
  private unevaluatedItems(schema: IrSchema, value: Code): void {
    const record = this.requireRecord();
    this.open(code`if (Array.isArray(${value}))`);
    if (schema.kind !== 'always') {
      const index = this.fresh('x');
      const unevaluated = this.fresh('unevaluated');
      this.open(code`if (!${record}.allItems)`);
      if (schema.kind === 'never') this.line(code`let ${unevaluated} = 0;`);
      this.open(code`for (let ${index} = 0; ${index} < ${value}.length; ${index}++)`);
      this.line(code`if (${index} < ${record}.prefix || ${record}.indexes.has(${index})) continue;`);
      if (schema.kind === 'never') {
        this.line(code`${unevaluated}++;`);
      } else {
        const item = this.fresh('item');
        this.line(code`const ${item} = ${value}[${index}];`);
        this.atChild(index, () => this.schema(schema, item));
      }
      this.close();
      if (schema.kind === 'never') this.leaf({ fails: code`${unevaluated} > 0`, issue: limitFields('tooBig', 'items', code`${value}.length - ${unevaluated}`, true) });
      this.close();
    }
    this.line(code`${record}.allItems = true;`);
    this.close();
  }

  /**
   * `if` runs with a scratch list and, when this function keeps a record, a scratch record that counts only when `if` passes.
   * The sanity level does not let `if` decide when its schema reaches a skipped check: `if` passing more would apply a
   * `then` that full does not. A `then` or `else` that reaches one is relaxed by its own flag and still applies.
   */
  private conditionalCheck(check: Extract<IrCheck, { kind: 'conditional' }>, value: Code): void {
    if (check.relaxed === true) return this.relaxedConditional(check, value);
    if (!this.relaxes([check.if])) return this.exactConditional(check, value);
    if (this.record === undefined) return this.unlessSanity(() => this.exactConditional(check, value));
    this.open(code`if (${SANITY})`);
    this.relaxedConditional(check, value);
    this.close();
    this.open(code`else`);
    this.exactConditional(check, value);
    this.close();
  }

  private exactConditional(check: Extract<IrCheck, { kind: 'conditional' }>, value: Code): void {
    const scratch = this.record === undefined ? undefined : this.fresh('scratch');
    if (scratch !== undefined) this.line(code`const ${scratch} = ${localName('newEvaluation')}();`);
    this.open(code`if (${this.call(check.if, { value, issues: code`[]`, all: code`false`, ...(scratch === undefined ? {} : { record: scratch }) })})`);
    if (scratch !== undefined && this.record !== undefined) this.line(code`${localName('mergeEvaluation')}(${this.record}, ${scratch});`);
    if (check.then !== undefined) this.callInPlace(check.then, value);
    this.close();
    if (check.else !== undefined) {
      this.open(code`else`);
      this.callInPlace(check.else, value);
      this.close();
    }
  }

  /** Only what `if`, `then` and `else` evaluate counts, each from a scratch record whatever they decide: a record that holds more accepts more. */
  private relaxedConditional(check: Extract<IrCheck, { kind: 'conditional' }>, value: Code): void {
    const record = this.record;
    if (record === undefined) return;
    for (const id of [check.if, check.then, check.else]) {
      if (id === undefined) continue;
      const scratch = this.fresh('scratch');
      this.line(code`const ${scratch} = ${localName('newEvaluation')}();`);
      this.line(code`${this.call(id, { value, issues: code`[]`, all: code`false`, record: scratch })};`);
      this.line(code`${localName('mergeEvaluation')}(${record}, ${scratch});`);
    }
  }

  private unionCheck(check: IrUnion, value: Code): void {
    if (this.record !== undefined) return this.recordingUnionCheck(check, value);
    const attempt = (fn: number): Code => this.call(fn, { value, issues: code`[]`, all: code`false` });
    if (!check.exactlyOne) return this.leaf({ fails: code`!(${this.typeDispatch(check.branches, value, attempt) ?? join(check.branches.map(attempt), code` || `)})`, issue: code`code: 'union', matched: 0` });
    const matched = this.fresh('matched');
    this.line(code`let ${matched} = 0;`);
    // Two matches already decide the outcome, so later branches are not run.
    check.branches.forEach((fn, position) => this.line(code`if (${position === 0 ? code`` : code`${matched} < 2 && `}${attempt(fn)}) ${matched}++;`));
    this.leaf({ fails: this.unionFails(check, matched), issue: code`code: 'union', matched: ${matched}` });
  }

  /** The test that fails a union with `matched` branches matching; the sanity level fails an untagged `oneOf` only when none matches, as it fails an `anyOf`, when a branch reaches a skipped check (two branches may then match that fail one at full). */
  private unionFails(check: IrUnion, matched: Code): Code {
    if (!check.exactlyOne) return code`${matched} === 0`;
    return this.relaxes(check.branches) ? code`${SANITY} ? ${matched} === 0 : ${matched} !== 1` : code`${matched} !== 1`;
  }

  /**
   * The test of an `anyOf` that picks the branches by the JSON type of the value: the first test that holds selects the
   * branches whose type list names that type, tried in order. A branch that cannot pass a value of another type is not
   * run for it, so the issues do not change. Undefined when a branch states no type, or when one type holds every
   * branch: the branches are then tried in order.
   */
  private typeDispatch(branches: readonly number[], value: Code, attempt: (fn: number) => Code): Code | undefined {
    const typesOf = branches.map(id => this.branchTypes(id));
    if (typesOf.some(types => types === undefined)) return undefined;
    const groups = JSON_TYPE_NAMES
      .map(name => ({ name, group: branches.filter((_, position) => typesOf[position]?.includes(name)) }))
      .filter(({ group }) => group.length > 0);
    if (groups.length < 2 || groups.some(({ group }) => group.length === branches.length)) return undefined;
    return code`${join(groups.map(({ name, group }) => code`${dispatchTest(name, value)} ? ${join(group.map(attempt), code` || `)} : `), code``)}false`;
  }

  /** The JSON types a value must have to pass the function `id` (after forwarding): those of its first `type` check, `integer` as `number`; undefined when it has none. */
  private branchTypes(id: number): readonly IrTypeName[] | undefined {
    const body = this.functions[this.target(id)].body;
    const type = body.kind === 'checks' ? body.checks.find(check => check.kind === 'type') : undefined;
    return type?.names.map(name => (name === 'integer' ? 'number' : name));
  }

  /** Every branch that passes marks what it evaluated, so `anyOf` runs all of its branches here. */
  private recordingUnionCheck(check: IrUnion, value: Code): void {
    const record = this.requireRecord();
    const matched = this.fresh('matched');
    this.line(code`let ${matched} = 0;`);
    // Two matches decide an exact `oneOf`, but the sanity level fails none: every branch that passes marks what it evaluated.
    const stops = this.relaxes(check.branches) ? code`${SANITY} || ${matched} < 2` : code`${matched} < 2`;
    check.branches.forEach((fn, position) => {
      const scratch = this.fresh('scratch');
      this.open(position === 0 || !check.exactlyOne ? undefined : code`if (${stops})`);
      this.line(code`const ${scratch} = ${localName('newEvaluation')}();`);
      this.open(code`if (${this.call(fn, { value, issues: code`[]`, all: code`false`, record: scratch })})`);
      this.line(code`${matched}++;`);
      this.line(code`${localName('mergeEvaluation')}(${record}, ${scratch});`);
      this.close();
      this.close();
    });
    this.leaf({ fails: this.unionFails(check, matched), issue: code`code: 'union', matched: ${matched}` });
  }

  /**
   * The tag selects the branch; only that branch's issues are reported, and an unknown tag is a `literal` issue on the
   * tag property. The tag is read once; the first branch whose list holds it is selected, as a tag lies in one list.
   * With an optional tag, a value that selects no branch is checked as a plain `oneOf`: it may match without the tag.
   */
  private discriminatedUnion(check: IrUnion, discriminator: IrDiscriminator, value: Code): void {
    const merged = discriminator.optional ? undefined : this.mergedBranches(check);
    if (merged !== undefined) {
      const targets = check.branches.map(id => this.target(id));
      for (const target of targets) this.merging.add(target);
      this.mergedUnion(merged, discriminator, value);
      for (const target of targets) this.merging.delete(target);
      return;
    }
    const presence = objectPresence(value);
    const property = literalCode(discriminator.property);
    const tag = this.fresh('tag');
    const selected = this.fresh('branch');
    const read = this.mode.form<Lazy>(
      () => code`${localName('isObject')}(${value}) && ${presence.present(discriminator.property)} ? ${presence.read(discriminator.property)} : undefined`,
      code`${localName('isObject')}(${value}) ? (${presentValueCode(value, property, code`${value}[${property}]`)}) : undefined`,
    );
    this.line(code`const ${tag} = ${resolve(read)};`);
    const selection = this.mode.form<Lazy>(
      () => code`${this.tagLists(discriminator)}.findIndex(list => list.some(item => ${runtime.jsonEqual}(${tag}, item)))`,
      () => this.tagSelection(discriminator, tag),
    );
    this.line(code`const ${selected} = ${resolve(selection)};`);
    check.branches.forEach((fn, position) => {
      this.open(code`if (${selected} === ${literalCode(position)})`);
      this.callInPlace(fn, value);
      this.close();
    });
    if (discriminator.optional) {
      this.open(code`if (${selected} < 0)`);
      this.unionCheck(check, value);
      this.close();
      return;
    }
    this.leaf({
      fails: code`${selected} < 0`,
      issue: () => code`code: 'literal', expected: ${this.state.constant('lit', code`Object.freeze(/*#__PURE__*/ JSON.parse(${literalCode(JSON.stringify(discriminator.tags.flat()))}))`, JSON.stringify(discriminator.tags.flat()))}`,
      path: code`[...${PATH}, ${property}]`,
    });
  }

  /** The module constant that holds the tag lists of `discriminator`. */
  private tagLists(discriminator: IrDiscriminator): Code {
    return this.state.constant('tags', code`Object.freeze(/*#__PURE__*/ JSON.parse(${literalCode(JSON.stringify(discriminator.tags))}))`, JSON.stringify(discriminator.tags));
  }

  /**
   * The branch position of the tag held by `tag`, or -1: the first branch whose list holds it, as a tag lies in one list.
   * A primitive tag is compared with `===`, which `jsonEqual` starts with, and no function is made per call.
   */
  private tagSelection(discriminator: IrDiscriminator, tag: Code): Code {
    const matches = (position: number): Code => {
      const tests = discriminator.tags[position]
        .map((item, index) => (isPrimitive(item) ? code`${tag} === ${literalCode(item)}` : code`${runtime.jsonEqual}(${tag}, ${this.tagLists(discriminator)}[${literalCode(position)}][${literalCode(index)}])`));
      return tests.length === 0 ? code`false` : join(tests, code` || `);
    };
    return join([...discriminator.tags.map((_, position) => code`${matches(position)} ? ${literalCode(position)} : `), code`-1`]);
  }

  /**
   * The object check of each branch, when the mode merges every branch of this union: each is, after forwarding, a
   * function of a type `object` check and one object check that only `properties`, `required` inside them and
   * `additionalProperties` absent, `true` or `false` make. Any other branch leaves the union to the branch calls, as
   * does a branch that is the function being written or one of a union being written in place: a recursive union
   * calls the branch's function instead of writing it in place again.
   */
  private mergedBranches(check: IrUnion): readonly IrObject[] | undefined {
    const merges = this.mode.mergesBranch;
    if (merges === undefined) return undefined;
    const objects: IrObject[] = [];
    for (const id of check.branches) {
      const target = this.target(id);
      if (target === this.fn.id || this.merging.has(target)) return undefined;
      const fn = this.functions[target];
      // A function that keeps or receives an evaluation record has no fast check, so `merges` excludes it.
      if (!merges(target) || fn.body.kind !== 'checks' || fn.body.checks.length !== 2) return undefined;
      const [type, object] = fn.body.checks;
      if (type.kind !== 'type' || type.names.length !== 1 || type.names[0] !== 'object' || object.kind !== 'object') return undefined;
      const named = new Set(object.properties.map(property => property.key));
      const additional = object.additional;
      if (object.patternProperties.length > 0 || object.propertyNames !== undefined || object.minProperties !== undefined || object.maxProperties !== undefined
        || object.dependentRequired.length > 0 || !object.required.every(key => named.has(key))
        || (additional?.kind === 'schema' && additional.schema.kind !== 'always')) return undefined;
      objects.push(object);
    }
    return objects;
  }

  /**
   * A tagged union of plain object branches as one key pass: the pass reads the tag only, as the full validator does
   * before it selects a branch, and marks every other key it meets. A tag outside the JSON view selects no branch. The
   * selected branch then reads its read set (`readSet`) before any of its checks can fail, as the full branch reads it
   * up front, and runs its checks in the full branch's order. A closed branch also requires each key it does
   * not name to be absent. Every read is of an own enumerable key.
   */
  private mergedUnion(branches: readonly IrObject[], discriminator: IrDiscriminator, value: Code): void {
    this.failWhen(code`!${objectTest(value)}`);
    const reads = branches.map(object => readSet(object, false));
    const named = branches.map(object => new Set(object.properties.map(property => property.key)));
    // A merged branch reads every value only when `additionalProperties: false` closes it (see `mergedBranches`).
    const closed = reads.map(set => set.all);
    const keys = [...new Set([discriminator.property, ...named.flatMap(names => [...names]), ...reads.flatMap(set => set.declared)])];
    const tag = this.fresh('tag');
    const seen = keys.slice(1).map(key => [key, this.fresh('seen')] as const);
    // A key that no branch declares, for a closed branch to test.
    const extra = closed.some(Boolean) ? this.fresh('extra') : undefined;
    this.line(code`let ${join([tag, ...seen.map(([, mark]) => mark), ...(extra === undefined ? [] : [code`${extra} = false`])], COMMA)};`);
    const key = this.fresh('key');
    this.open(code`for (const ${key} of Object.keys(${value}))`);
    this.open(code`switch (${key})`);
    this.line(code`case ${literalCode(discriminator.property)}: ${tag} = ${value}[${literalCode(discriminator.property)}]; break;`);
    for (const [name, mark] of seen) this.line(code`case ${literalCode(name)}: ${mark} = true; break;`);
    if (extra !== undefined) this.line(code`default: ${extra} = true;`);
    this.close();
    this.close();
    const selected = this.fresh('branch');
    this.line(code`const ${selected} = ${this.tagSelection(discriminator, tag)};`);
    this.failWhen(code`${selected} < 0`);
    branches.forEach((object, position) => {
      this.open(code`if (${selected} === ${literalCode(position)})`);
      const { declared, all } = reads[position];
      const captured: Capture[] = [[discriminator.property, tag]];
      const absent: Capture[] = [];
      for (const [name, mark] of seen) {
        if (!all && !declared.includes(name)) continue;
        const local = this.fresh('present');
        this.line(code`const ${local} = ${mark} ? ${value}[${literalCode(name)}] : undefined;`);
        if (named[position].has(name) || declared.includes(name)) captured.push([name, local]);
        else absent.push([name, local]);
      }
      const unknown = closed[position] && extra !== undefined ? this.fresh('unknown') : undefined;
      if (unknown !== undefined && extra !== undefined) {
        const other = this.fresh('key');
        this.line(code`let ${unknown} = false;`);
        this.open(code`if (${extra})`);
        this.open(code`for (const ${other} of Object.keys(${value}))`);
        this.open(code`switch (${other})`);
        this.line(code`${join(keys.map(name => code`case ${literalCode(name)}:`), code` `)} break;`);
        this.line(code`default: if (${value}[${other}] !== undefined && !${localName('isInstanceState')}(${value}, ${other})) ${unknown} = true;`);
        this.close();
        this.close();
        this.close();
      }
      if (closed[position]) {
        if (!named[position].has(discriminator.property)) this.failWhen(code`${tag} !== undefined`);
        // A key that the instance's own model declares is judged; any other own key is program state.
        for (const [name, local] of absent) this.failWhen(code`${local} !== undefined && !${localName('isInstanceState')}(${value}, ${literalCode(name)})`);
        if (unknown !== undefined) this.failWhen(unknown);
      }
      this.objectKeywords(object, value, { presence: objectPresence(value, captured) });
      this.close();
    });
  }
}
