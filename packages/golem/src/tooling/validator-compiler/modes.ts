import { code, join, literal as literalCode, nameOf, type Code } from '../code.js';
import type { IrObject, IrPatternProperty } from './ir.js';
import { presentKeysCode } from '../union-conversion.js';
import { PATH, COMMA, ISSUES, ALL, callFunction, type CallArguments } from './function-names.js';
import { localName, stateTest } from './local-helpers.js';
import { patternExpression } from './module-state.js';
import type { FunctionWriter } from './function-writer.js';
import type { FastPlan } from './fast-plan.js';

/** What a written function does when a check fails. */
interface FailMode {
  /** The lines that open the body, before the first check. */
  readonly start: readonly Code[];
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
  /** Statements that run before the first `present` or `read`. */
  readonly setup: readonly Code[];
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

/** What the key test of one object leaves for the checks after it. */
export interface KeyTest {
  readonly presence: PresenceReader;
  /** An expression that holds the number of keys by the JSON view, when `minProperties` or `maxProperties` reads it. */
  readonly count?: Code;
  /** An expression that lists the keys by the JSON view, for the checks that loop over them; `undefinedToo` when it also lists keys whose value is `undefined`. */
  readonly keys?: Code;
  readonly undefinedToo?: boolean;
  /** A local that is true when the key test met a key that `additionalProperties: false` forbids; the test runs after `required`. */
  readonly unknown?: Code;
  /**
   * Set when the key test left the own values unread: the statement that a failing check runs before it fails as it
   * would without this object. It reads every value first, as the full validator does, and the passes over the key list read each value
   * before they skip a key.
   */
  readonly failure?: Code;
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
export function readSet(check: IrObject, marks: boolean): ReadSet {
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
   * True for a function whose checks a tagged union may write in place of calling it (see `mergedBranches`); absent
   * when the mode always calls each branch.
   */
  readonly mergesBranch?: (id: number) => boolean;
}

const REPORT_FAILURE = code`ok = false; if (!${ALL}) { ${PATH}.length = pl; return false; }`;

export function objectPresence(value: Code, captured: readonly Capture[] = []): PresenceReader {
  // One Object.keys pass reads the declared keys of an object; the faster exact form of the JSON view.
  const locals = new Map(captured);
  return {
    setup: captured.length > 0 ? [presentKeysCode(value, captured)] : [],
    present: key => { const local = locals.get(key); return local !== undefined ? code`(${local} !== undefined)` : code`${localName('isPresent')}(${value}, ${literalCode(key)})`; },
    read: key => locals.get(key) ?? code`${value}[${literalCode(key)}]`,
  };
}

/** The full validator: a failed check pushes its issue, then returns at once unless all errors are wanted; a key is read through `isPresent`. */
export const FULL_VALIDATOR: WriterMode = {
  fail: {
    start: [code`const pl = ${PATH}.length;`, code`let ok = true;`],
    end: code`return ok;`,
    issue: (fields, path) => [code`${ISSUES}.push({ path: ${path}, ${fields} });`, REPORT_FAILURE],
    fail: () => REPORT_FAILURE,
    leaves: false,
  },
  form: full => full,
  // Reads the declared keys; the checks after it loop over the key list for unknown keys and patterns.
  keyTest: (writer, { check, value, captured, reads }) => {
    const presence = objectPresence(value, captured);
    for (const line of presence.setup) writer.line(line);
    const keys = writer.fresh('keys');
    if (reads.all) writer.line(code`const ${keys} = ${localName('definedKeys')}(${value});`);
    if (check.minProperties === undefined && check.maxProperties === undefined) return { presence, ...(reads.all ? { keys } : {}) };
    // The program state of a model instance does not count.
    const count = writer.fresh('count');
    const key = writer.fresh('key');
    const fields = writer.fresh('fields');
    writer.line(code`const ${fields} = ${localName('instanceFields')}(${value});`);
    writer.line(code`let ${count} = ${keys}.length;`);
    writer.line(code`if (${fields} !== undefined) for (const ${key} of ${keys}) if (${stateTest(fields, key)}) ${count}--;`);
    return { presence, count, keys };
  },
  call: (writer, id, args) => {
    const target = writer.target(id);
    writer.calls.add(target);
    return callFunction(writer.functions[target], nameOf(writer.calleeSlot(target, false)), args);
  },
  child: (writer, token, body) => {
    writer.line(code`${PATH}.push(${token});`);
    body();
    writer.line(code`${PATH}.pop();`);
  },
  records: true,
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
 * passes over the key list read them, and a failure of theirs reads the rest before it leaves (`KeyTest.failure`).
 */
function fastKeyTest(writer: FunctionWriter, { check, value, captured, reads }: KeyTestRequest): KeyTest {
  const presence = objectPresence(value, captured);
  if (!reads.all) {
    for (const line of presence.setup) writer.line(line);
    return { presence };
  }
  const counts = check.minProperties !== undefined || check.maxProperties !== undefined;
  const count = counts ? writer.fresh('count') : undefined;
  const additional = reads.visitsAdditional ? check.additional : undefined;
  const unknown = additional?.kind === 'forbid' ? writer.fresh('unknown') : undefined;
  const locals = [...captured.map(([, local]) => local), ...(count === undefined ? [] : [code`${count} = 0`]), ...(unknown === undefined ? [] : [code`${unknown} = false`])];
  if (locals.length > 0) writer.line(code`let ${join(locals, COMMA)};`);
  const list = additional?.kind === 'schema' || reads.patterns.length > 0 || check.propertyNames !== undefined ? writer.fresh('keys') : undefined;
  if (list !== undefined) writer.line(code`const ${list} = Object.keys(${value});`);
  const key = writer.fresh('key');
  const named = new Set(check.properties.map(property => property.key));
  const capturedKeys = new Set(captured.map(([name]) => name));
  // A key counts when its value is not `undefined`; a key nothing else reads is read on its own.
  const counted = (read: Code): Code => (count === undefined ? code` ${read};` : code` if (${read} !== undefined) ${count}++;`);
  const cases = [
    ...captured.filter(([name]) => additional === undefined || named.has(name)).map(([name, local]) => code`case ${literalCode(name)}: ${local} = ${value}[${literalCode(name)}];${count === undefined ? code`` : counted(local)} break;`),
    ...[...named].filter(name => !capturedKeys.has(name)).map(name => code`case ${literalCode(name)}:${counted(code`${value}[${literalCode(name)}]`)} break;`),
  ];
  // A required or dependent key that `properties` does not name is still additional: `default` captures it.
  const unnamed = additional === undefined ? [] : captured.filter(([name]) => !named.has(name));
  // A pass with no case, no count, no unknown key and no captured key only reads the values. The passes over the key
  // list read them all too, and a failure of theirs reads the rest first (`failure`), so the pass is left out.
  if (list !== undefined && cases.length === 0 && count === undefined && unknown === undefined && unnamed.length === 0) {
    return { presence, keys: list, undefinedToo: true, failure: code`${localName('readAll')}(${value}, ${list});` };
  }
  const item = writer.fresh('item');
  writer.open(code`for (const ${key} of ${list ?? code`Object.keys(${value})`})`);
  writer.open(code`switch (${key})`);
  for (const entry of cases) writer.line(entry);
  writer.open(code`default:`);
  writer.line(code`const ${item} = ${value}[${key}];`);
  writer.line(code`if (${item} === undefined) continue;`);
  if (count !== undefined) writer.line(code`${count}++;`);
  unnamed.forEach(([name, local], position) => writer.line(code`${position === 0 ? code`` : code`else `}if (${key} === ${literalCode(name)}) ${local} = ${item};`));
  if (unknown !== undefined) {
    const patterns = check.patternProperties.map(entry => code`${patternExpression(writer.state, entry.pattern)}.test(${key})`);
    const state = code`!${localName('isInstanceState')}(${value}, ${key})`;
    writer.line(code`if (${patterns.length === 0 ? state : code`!(${join(patterns, code` || `)}) && ${state}`}) ${unknown} = true;`);
  }
  writer.close();
  writer.close();
  writer.close();
  if (count !== undefined) {
    // The names that the instance's own model declares: a key outside them is program state and does not count, the
    // full validator's rule. A plain value has no such names and runs no second pass.
    const fields = writer.fresh('fields');
    writer.line(code`const ${fields} = ${localName('instanceFields')}(${value});`);
    writer.line(code`if (${fields} !== undefined) for (const ${key} of ${list ?? code`Object.keys(${value})`}) if (!${fields}.includes(${key}) && ${value}[${key}] !== undefined) ${count}--;`);
  }
  return {
    presence,
    ...(count === undefined ? {} : { count }),
    ...(unknown === undefined ? {} : { unknown }),
    ...(list === undefined ? {} : { keys: list, undefinedToo: true }),
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
    return code`${localName('leafPasses')}(${nameOf(writer.calleeSlot(id, false))}, ${value})`;
  };
  return {
    fail: { start: [], end: code`return true;`, issue: () => [code`return false;`], fail: () => code`return false;`, leaves: true },
    form: (full, fast) => fast ?? full,
    keyTest: fastKeyTest,
    call: (writer, id, args) => {
      const target = writer.target(id);
      if (!plan.has(target)) return leafCall(writer, target, args.value);
      writer.fastCalls.add(target);
      return code`${nameOf(writer.calleeSlot(target, true))}(${args.value})`;
    },
    child: (_writer, _token, body) => body(),
    records: false,
    // A branch with a fast check is exact on its own, so its checks are exact in place too.
    mergesBranch: id => plan.has(id),
  };
}
