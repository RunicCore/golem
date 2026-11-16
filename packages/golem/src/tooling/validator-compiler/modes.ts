import { code, join, literal as literalCode, nameOf, type Code } from '../code.js';
import type { IrObject, IrPatternProperty } from './ir.js';
import { rt } from '../rt.js';
import { PRESENT_KEY, presentKeysCode } from '../union-conversion.js';
import { PATH, PATH_LENGTH, COMMA, ISSUES, ALL, callFunction, type CallArguments } from './function-names.js';
import { instanceFieldsOf, stateTest } from './local-helpers.js';
import { patternExpression } from './module-state.js';
import type { FunctionWriter } from './function-writer.js';
import type { FastPlan } from './fast-plan.js';

/** A line that opens the body of a function, before the first check. */
interface Opening {
  readonly line: Code;
  /** The local the line declares, when a body that never reads it leaves the line out; absent when the line always stays. */
  readonly local?: Code;
}

/** What a written function does when a check fails. */
interface FailMode {
  /** The lines that open the body, before the first check. */
  readonly start: readonly Opening[];
  /** The line that ends the body once every check passed or was reported. */
  readonly end: Code;
  /** The statements of a check that failed with the issue `fields` at `path`. */
  issue(fields: Code, path: Code): readonly Code[];
  /** The statement of a check that failed where a callee already reported the issue. */
  fail(): Code;
  /** A failed check leaves the function at once with its verdict: its issue is never built and nothing after it runs. */
  readonly leaves: boolean;
}

/** The local that a declared key's value is read into. */
export type Capture = readonly [key: string, local: Code];

/** How the checks of one object tell that a declared key is present, and read its value once it is. */
interface PresenceReader {
  /** An expression that is true when `key` is present by the JSON view. */
  present(key: string): Code;
  /** An expression that reads the value of `key`; written only where `present(key)` holds. */
  read(key: string): Code;
}

/**
 * Generated code, or a function that writes it when a mode uses it, so a constant, helper or local that only one mode
 * reads is declared only by that mode. The test of a leaf check can hold a call of another function.
 */
export type Lazy = Code | (() => Code);

export function resolve(value: Lazy): Code {
  return typeof value === 'function' ? value() : value;
}

/** What the key test of one object is given. */
interface KeyTestRequest {
  readonly check: IrObject;
  readonly value: Code;
  /** A local for each declared key the object's checks read. */
  readonly captured: readonly Capture[];
  /** The object's read set; `captured` holds its declared keys. */
  readonly reads: ReadSet;
}

/**
 * The list of an object's own keys that a key test leaves for the passes that loop over the keys. `defined`: the list
 * of `definedKeys`, which holds no program state and no key whose value is `undefined`. `raw`: each own key as it is,
 * so a pass leaves out program state of a model instance (`stateFields`, the local that holds the names of the
 * instance's own model, for `isStateKey`) and keys whose value is `undefined` before it reads a value. `unread`: a
 * raw list for which the key test left the own values unread; `failure` is the statement that a failing check runs
 * before it fails as it would without this object. It reads every value first, as the full validator does, and the
 * passes over the key list read each value before they skip a key.
 */
export type KeyList = DefinedKeys | RawKeys | UnreadKeys;

interface DefinedKeys {
  readonly kind: 'defined';
  readonly keys: Code;
}

export interface RawKeys {
  readonly kind: 'raw';
  readonly keys: Code;
  readonly stateFields: Code;
}

export interface UnreadKeys {
  readonly kind: 'unread';
  readonly keys: Code;
  readonly stateFields: Code;
  readonly failure: Code;
}

/** What the key test of one object leaves for the checks after it. */
export interface KeyTest {
  readonly presence: PresenceReader;
  /** An expression that holds the number of keys by the JSON view, when `minProperties` or `maxProperties` reads it. */
  readonly count?: Code;
  /** The key list, for the checks that loop over the keys. */
  readonly list?: KeyList;
  /** A local that is true when the key test met a key that `additionalProperties: false` forbids; the test runs after `required`. */
  readonly unknown?: Code;
}

/** Which own values of an object the full validator reads before its checks. */
interface ReadSet {
  /** The declared keys whose checks read their values; the full validator reads these first. */
  readonly declared: readonly string[];
  /** The `patternProperties` entries whose checks run. */
  readonly patterns: readonly IrPatternProperty[];
  /** `additionalProperties` tests the keys that `properties` does not name. */
  readonly visitsAdditional: boolean;
  /** A keyword judges the whole key list, so every own value is read (`definedKeys`). */
  readonly all: boolean;
}

/**
 * The full validator's read set of an object check, the one rule for the full validator, the fast key test
 * and the merged union pass. `marks`: the function keeps an evaluation record, so a check that accepts anything still
 * marks its key.
 */
export function readSet(check: IrObject, { marks }: { readonly marks: boolean }): ReadSet {
  const declared = [...new Set([
    ...check.required,
    ...check.dependentRequired.flatMap(({ trigger, keys }) => keys.length > 0 ? [trigger, ...keys] : []),
    ...check.properties.filter(property => property.schema.kind !== 'always' || marks).map(property => property.key),
  ])];
  const patterns = check.patternProperties.filter(entry => entry.schema.kind !== 'always' || marks);
  const visitsAdditional = check.additional !== undefined && (check.additional.kind === 'forbid' || check.additional.schema.kind !== 'always');
  const all = check.minProperties !== undefined || check.maxProperties !== undefined || patterns.length > 0 || visitsAdditional || check.propertyNames !== undefined;
  return { declared, patterns, visitsAdditional, all };
}

/**
 * The mode of a `FunctionWriter`: one traversal and one definition of each leaf check, written as the function the mode
 * asks for.
 */
export interface WriterMode {
  readonly fail: FailMode;
  /** The form the mode writes of a check that has a full form and may have a cheaper fast one. */
  readonly form: <Form extends Lazy>(full: Form, fast: Form | undefined) => Form;
  /** Writes the key test of an object: it reads the declared keys, and in the fast check also tests the unknown keys and counts the keys. */
  readonly keyTest: (writer: FunctionWriter, request: KeyTestRequest) => KeyTest;
  /** An expression that is true when the function `id` passes `args.value`. */
  readonly call: (writer: FunctionWriter, id: number, args: CallArguments) => Code;
  /** Writes `body`, which checks the child `token` of the current value. */
  readonly child: (writer: FunctionWriter, token: Code, body: () => void) => void;
  /** The mode writes functions that keep or receive an evaluation record. */
  readonly records: boolean;
  /**
   * The mode writes a function that takes the sanity flag `s` and writes a skipped check under it. A fast check takes
   * none and is exact. The generated guards run it first at every level, which is sound because a value that is valid at
   * the full level is valid at the sanity level; a full validator it calls runs with the flag absent.
   */
  readonly takesSanity: boolean;
  /**
   * True for a function whose checks a tagged union may write in place of calling it (see `mergedBranches`); absent
   * when the mode always calls each branch.
   */
  readonly mergesBranch?: (id: number) => boolean;
}

const runtime = rt['validation-runtime'];

const REPORT_FAILURE = code`ok = false; if (!${ALL}) { ${PATH}.length = ${PATH_LENGTH}; return false; }`;

export function objectPresence(value: Code, captured: readonly Capture[] = []): PresenceReader {
  const locals = new Map(captured);
  return {
    present: key => { const local = locals.get(key); return local !== undefined ? code`(${local} !== undefined)` : code`${runtime.isPresent}(${value}, ${literalCode(key)})`; },
    read: key => locals.get(key) ?? code`${value}[${literalCode(key)}]`,
  };
}

/**
 * The one `Object.keys` pass that reads each captured key once, the faster exact form of the JSON view. `fields` is the local that
 * holds the names of the value's own model: program state is never read, also when its name is a captured key.
 */
function readCaptured(writer: FunctionWriter, value: Code, captured: readonly Capture[], fields: Code): void {
  writer.line(presentKeysCode(value, captured, { skip: stateTest(fields, PRESENT_KEY), declare: local => code`${local}${writer.state.notation.read}` }));
}

/** The full validator: a failed check pushes its issue, then returns at once unless all errors are wanted; a key is read through `isPresent`. */
export const FULL_VALIDATOR: WriterMode = {
  fail: {
    start: [{ line: code`const ${PATH_LENGTH} = ${PATH}.length;`, local: PATH_LENGTH }, { line: code`let ok = true;` }],
    end: code`return ok;`,
    issue: (fields, path) => [code`${ISSUES}.push({ path: ${path}, ${fields} });`, REPORT_FAILURE],
    fail: () => REPORT_FAILURE,
    leaves: false,
  },
  form: full => full,
  // Reads the declared keys; the checks after it loop over the key list for unknown keys and patterns.
  keyTest: (writer, { check, value, captured, reads }) => {
    const fields = writer.fresh('fields');
    if (captured.length > 0 || reads.all) writer.line(code`const ${fields} = ${instanceFieldsOf(value)};`);
    if (captured.length > 0) readCaptured(writer, value, captured, fields);
    const keys = writer.fresh('keys');
    if (reads.all) writer.line(code`const ${keys} = ${runtime.definedKeys}(${value}, ${fields});`);
    // `definedKeys` leaves out the program state of a model instance, so it does not count.
    const list: KeyList = { kind: 'defined', keys };
    if (check.minProperties === undefined && check.maxProperties === undefined) return { presence: objectPresence(value, captured), ...(reads.all ? { list } : {}) };
    return { presence: objectPresence(value, captured), count: code`${keys}.length`, list };
  },
  call: (writer, id, args) => {
    const target = writer.target(id);
    writer.calls.add(target);
    return callFunction(writer.functions[target], nameOf(writer.calleeSlot(target, 'full')), args);
  },
  child: (writer, token, body) => {
    writer.line(code`${PATH}.push(${token});`);
    body();
    writer.line(code`${PATH}.pop();`);
  },
  records: true,
  takesSanity: true,
};

/**
 * The key test of the fast check. An object whose full validator reads only its declared keys reads
 * them as the full validator does. Any other reads every own value in one `Object.keys` pass, as `definedKeys` does,
 * with no exit inside the pass (a caller such as `not` or a union can turn a `false` into `true`, and then the
 * reads must be the full validator's): a declared key in its own case by its name, every other key in `default`. A key
 * that `additionalProperties: false` forbids is only marked, and a schema of `additionalProperties` runs after
 * `required` in a second pass, both in the full validator's order. A key that matches a pattern of `patternProperties` is
 * not additional. A keyword that loops over the keys (a schema of `additionalProperties`, `patternProperties`,
 * `propertyNames`) gets the one key list, which also holds the keys whose value is `undefined`. The pass is written only
 * when it has a case, a count, an unknown key or a captured key to handle. Otherwise it would only read the values: the
 * passes over the key list read them, and a failure of theirs reads the rest before it leaves (`KeyList.failure`).
 */
function fastKeyTest(writer: FunctionWriter, { check, value, captured, reads }: KeyTestRequest): KeyTest {
  const presence = objectPresence(value, captured);
  const fields = writer.fresh('fields');
  if (!reads.all) {
    if (captured.length > 0) {
      writer.line(code`const ${fields} = ${instanceFieldsOf(value)};`);
      readCaptured(writer, value, captured, fields);
    }
    return { presence };
  }
  const counts = check.minProperties !== undefined || check.maxProperties !== undefined;
  const count = counts ? writer.fresh('count') : undefined;
  const additional = reads.visitsAdditional ? check.additional : undefined;
  const unknown = additional?.kind === 'forbid' ? writer.fresh('unknown') : undefined;
  const locals = [...captured.map(([, local]) => code`${local}${writer.state.notation.read}`), ...(count === undefined ? [] : [code`${count} = 0`]), ...(unknown === undefined ? [] : [code`${unknown} = false`])];
  if (locals.length > 0) writer.line(code`let ${join(locals, COMMA)};`);
  writer.line(code`const ${fields} = ${instanceFieldsOf(value)};`);
  const list = additional?.kind === 'schema' || reads.patterns.length > 0 || check.propertyNames !== undefined ? writer.fresh('keys') : undefined;
  if (list !== undefined) writer.line(code`const ${list} = Object.keys(${value});`);
  const key = writer.fresh('key');
  const state = (name: Code): Code => stateTest(fields, name);
  const named = new Set(check.properties.map(property => property.key));
  const capturedKeys = new Set(captured.map(([name]) => name));
  // A key counts when its value is not `undefined`; a key nothing else reads is read on its own.
  const counted = (read: Code): Code => (count === undefined ? code` ${read};` : code` if (${read} !== undefined) ${count}++;`);
  const cases = captured.filter(([name]) => additional === undefined || named.has(name)).map(([name, local]) => code`case ${literalCode(name)}: ${local} = ${value}[${literalCode(name)}];${count === undefined ? code`` : code` if (${local} !== undefined) ${count}++;`} break;`);
  const bare = [...named].filter(name => !capturedKeys.has(name));
  // A required or dependent key that `properties` does not name is still additional: `default` captures it.
  const unnamed = additional === undefined ? [] : captured.filter(([name]) => !named.has(name));
  // A pass with no case, no count, no unknown key and no captured key only reads the values. The passes over the key
  // list read them all too, and a failure of theirs reads the rest first (`failure`), so the pass is left out.
  if (list !== undefined && cases.length === 0 && bare.length === 0 && count === undefined && unknown === undefined && unnamed.length === 0) {
    return { presence, list: { kind: 'unread', keys: list, stateFields: fields, failure: code`${runtime.readAll}(${value}, ${list});` } };
  }
  const item = writer.fresh('item');
  writer.open(code`for (const ${key} of ${list ?? code`Object.keys(${value})`})`);
  // Program state is never read, whatever its name: it is no declared key, no counted key and no unknown key.
  writer.line(code`if (${state(key)}) continue;`);
  writer.open(code`switch (${key})`);
  for (const entry of cases) writer.line(entry);
  if (bare.length > 0) writer.line(code`${join(bare.map(name => code`case ${literalCode(name)}:`), code` `)}${counted(code`${value}[${key}]`)} break;`);
  writer.open(code`default:`);
  writer.line(code`const ${item} = ${value}[${key}];`);
  writer.line(code`if (${item} === undefined) continue;`);
  if (count !== undefined) writer.line(code`${count}++;`);
  unnamed.forEach(([name, local], position) => writer.line(code`${position === 0 ? code`` : code`else `}if (${key} === ${literalCode(name)}) ${local} = ${item};`));
  if (unknown !== undefined) {
    const patterns = check.patternProperties.map(entry => code`${patternExpression(writer.state, entry.pattern)}.test(${key})`);
    writer.line(patterns.length === 0 ? code`${unknown} = true;` : code`if (!(${join(patterns, code` || `)})) ${unknown} = true;`);
  }
  writer.close();
  writer.close();
  writer.close();
  return {
    presence,
    ...(count === undefined ? {} : { count }),
    ...(unknown === undefined ? {} : { unknown }),
    ...(list === undefined ? {} : { list: { kind: 'raw', keys: list, stateFields: fields } }),
  };
}

/**
 * The fast check `is_X(v)`: true exactly when the full validator reports no issue. A failed check returns
 * `false`; no path and no issue is built. A function with a fast check is called as `isN(v)`; any other through its full
 * validator (`leafPasses`).
 */
export function fastCheckMode(plan: FastPlan): WriterMode {
  const leafCall = (writer: FunctionWriter, id: number, value: Code): Code => {
    writer.calls.add(id);
    return code`${runtime.leafPasses}(${nameOf(writer.calleeSlot(id, 'full'))}, ${value})`;
  };
  return {
    fail: { start: [], end: code`return true;`, issue: () => [code`return false;`], fail: () => code`return false;`, leaves: true },
    form: (full, fast) => fast ?? full,
    keyTest: fastKeyTest,
    call: (writer, id, args) => {
      const target = writer.target(id);
      if (!plan.has(target)) return leafCall(writer, target, args.value);
      writer.fastCalls.add(target);
      return code`${nameOf(writer.calleeSlot(target, 'fast'))}(${args.value})`;
    },
    child: (_writer, _token, body) => body(),
    records: false,
    takesSanity: false,
    // A branch with a fast check is exact on its own, so its checks are exact in place too.
    mergesBranch: id => plan.has(id),
  };
}
