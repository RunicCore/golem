import type { IrArray, IrCheck, IrDiscriminator, IrFunction, IrInstance, IrModule, IrNumber, IrObject, IrSchema, IrString, IrType, IrTypeName, IrUnion, IrValidation, IrValidationImport } from './ir.js';

import { MODEL_CODEC_IDS_KEY } from '../../schema-keywords.js';
import { presentKeysSource, presentValueSource } from '../../presence.js';

export interface EmitOptions {
  /** The module specifier the generated file imports its runtime helpers from. */
  readonly runtimeModule: string;
  /** Types each exported validator as a `Validator`, for a TypeScript file. */
  readonly typed?: boolean;
  /** Also writes the boolean fast check `is_X` beside `validate_X`, for each root, or each root named, that has one (see `FastPlan`). */
  readonly fastPath?: boolean | ReadonlySet<string>;
}

export interface EmitResult {
  readonly source: string;
  /** The name each root's fast check is exported under, by root name; only roots that have one. */
  readonly fastExports: ReadonlyMap<string, string>;
}

type RuntimeHelper = 'checkFormat' | 'codePointLength' | 'formatTest' | 'jsonEqual';
type LocalHelper = 'isPresent' | 'definedKeys' | 'isObject' | 'isMultipleOf' | 'hashedId' | 'selectedModel' | 'modelOf' | 'newEvaluation' | 'mergeEvaluation' | 'leafPasses';

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

/** The name a root's fast check is exported under: its `validate_` name with `is_` instead (`validate_User` becomes `is_User`). */
function fastExportName(validateName: string): string {
  return `is_${validateName.slice('validate_'.length)}`;
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

/** Stands for the fast check of a function, as `functionMark` stands for the function. */
const FAST_MARK = /\u0001(\d+)\u0001/g;

function fastMark(id: number): string {
  return `\u0001${id}\u0001`;
}

/** The fast check of the function named `name` (`f3_User` becomes `is3_User`). */
function fastName(name: string): string {
  return `is${name.slice(1)}`;
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

/** True when the registered codec id `registered` is the model `id`, in the text of `selectedModel` and `modelOf`. */
const MODEL_ID_MATCHES = 'registered === id\n    || (!hashedId.test(id) && registered.length === id.length + 9 && registered.startsWith(id + "_") && hashedId.test(registered))';

const LOCAL_HELPERS: Readonly<Record<LocalHelper, string>> = {
  // The JSON view: a key is present when it is own, enumerable and not `undefined`, as `JSON.stringify` writes it. A
  // model's optional field may be set to `undefined` and JSON has no such value.
  definedKeys: 'const definedKeys = value => Object.keys(value).filter(key => value[key] !== undefined);',
  isPresent: 'const isPresent = (value, key) => Object.prototype.propertyIsEnumerable.call(value, key) && value[key] !== undefined;',
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
  hashedId: 'const hashedId = /_[0-9a-f]{8}$/;',
  // The registered model class a value is an instance of, as `golemModelInstance` reads it. The symbol key is
  // `MODEL_CODEC_IDS_KEY`, which object-codec.ts registers under: the generated module imports nothing that registers classes. The most derived
  // registered prototype on the chain wins. A hashed codec id (`Name_1a2b3c4d`) matches exactly; an unhashed name also
  // matches the hashed ids of that name.
  selectedModel: [
    'function selectedModel(value, among) {',
    "  if (typeof value !== 'object' || value === null) return undefined;",
    `  const key = Symbol.for(${JSON.stringify(MODEL_CODEC_IDS_KEY)});`,
    `  const matches = (registered, id) => ${MODEL_ID_MATCHES};`,
    '  for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {',
    '    if (!Object.prototype.hasOwnProperty.call(prototype, key)) continue;',
    '    for (const id of among) if (prototype[key].some(registered => matches(registered, id))) return id;',
    '  }',
    '  return undefined;',
    '}',
  ].join('\n'),
  // `selectedModel` for the fast check: the same selection with the key read once at load and no function made per call.
  modelOf: [
    `const modelIdsKey = Symbol.for(${JSON.stringify(MODEL_CODEC_IDS_KEY)});`,
    `const modelIdMatches = (registered, id) => ${MODEL_ID_MATCHES};`,
    'function modelOf(value, among) {',
    "  if (typeof value !== 'object' || value === null) return undefined;",
    '  for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {',
    '    if (!Object.prototype.hasOwnProperty.call(prototype, modelIdsKey)) continue;',
    '    const registered = prototype[modelIdsKey];',
    '    for (let x = 0; x < among.length; x++) for (let y = 0; y < registered.length; y++) if (modelIdMatches(registered[y], among[x])) return among[x];',
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
  // The fast check runs a check that has no fast form through its full validator, fail-fast, and reads only the verdict.
  // The path and issue lists are module-level and emptied on each call, so a pass allocates nothing, and a call made
  // while another runs (a getter that validates) changes no verdict: only the returned boolean is read.
  leafPasses: [
    'const scratchPath = [];',
    'const scratchIssues = [];',
    'function leafPasses(validate, value) {',
    '  scratchPath.length = 0;',
    '  scratchIssues.length = 0;',
    '  return validate(value, scratchPath, scratchIssues, false);',
    '}',
  ].join('\n'),
};

/** The helpers a helper's text uses. */
const HELPER_NEEDS: Readonly<Partial<Record<LocalHelper, readonly LocalHelper[]>>> = {
  selectedModel: ['hashedId'],
  modelOf: ['hashedId'],
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
    for (const needed of HELPER_NEEDS[name] ?? []) this.helpers.add(needed);
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

/** What a written function does when a check fails. */
interface FailMode {
  /** The lines that open the body, before the first check. */
  readonly start: readonly string[];
  /** The line that ends the body once every check passed or was reported. */
  readonly end: string;
  /** The statements of a check that failed with the issue `fields` at `path`. */
  issue(fields: string, path: string): readonly string[];
  /** The statement of a check that failed where a callee already reported the issue. */
  fail(): string;
  /** A failed check leaves the function at once with its verdict: its issue is never built and nothing after it runs. */
  readonly leaves: boolean;
}

/** How the checks of one object tell that a declared key is present, and read its value once it is. */
interface PresenceReader {
  /** Statements that run before the first `present` or `read`. */
  readonly setup: readonly string[];
  /** An expression that is true when `key` is present by the JSON view. */
  present(key: string): string;
  /** An expression that reads the value of `key`; written only where `present(key)` holds. */
  read(key: string): string;
}

/**
 * Generated code, or a function that writes it when a mode uses it, so a constant, helper or local that only one mode
 * reads is declared only by that mode.
 */
type Text = string | (() => string);

function text(value: Text): string {
  return typeof value === 'string' ? value : value();
}

/** What the key test of one object is given. */
interface KeyTestRequest {
  readonly check: IrObject;
  readonly value: string;
  /** A local for each declared key the object's checks read. */
  readonly captured: readonly (readonly [key: string, local: string])[];
  /** A check after the key test loops over the keys of the object by the JSON view. */
  readonly needsKeys: boolean;
  /** `additionalProperties` tests the keys that `properties` does not name. */
  readonly visitsAdditional: boolean;
}

/** What the key test of one object leaves for the checks after it. */
interface KeyTest {
  readonly presence: PresenceReader;
  /** An expression that holds the number of keys by the JSON view, when `minProperties` or `maxProperties` reads it. */
  readonly count?: string;
  /** The local that lists the keys by the JSON view; absent when the key test already ran the checks that loop over them. */
  readonly keys?: string;
}

/**
 * The mode of a `FunctionWriter`: one traversal and one definition of each leaf check, written as the function the mode
 * asks for. `presence` gives the reader for the object `value`.
 */
interface WriterMode {
  readonly fail: FailMode;
  /** `captured` names a local for each declared key the object's checks read; a key outside it is read on its own. */
  readonly presence: (state: ModuleState, value: string, captured?: readonly (readonly [key: string, local: string])[]) => PresenceReader;
  /** The form the mode writes of a check that has a full form and may have a cheaper fast one. */
  readonly form: (full: Text, fast: Text | undefined) => Text;
  /** Writes the key test of an object: it reads the declared keys, and in the fast check also tests the unknown keys and counts the keys. */
  readonly keyTest: (writer: FunctionWriter, request: KeyTestRequest) => KeyTest;
  /** An expression that is true when the function `id` passes `args.value`. */
  readonly call: (writer: FunctionWriter, id: number, args: CallArguments) => string;
  /** Writes `body`, which checks the child `token` of the current value. */
  readonly child: (writer: FunctionWriter, token: string, body: () => void) => void;
  /** An expression that selects the model class of `value` among the codec ids `among`. */
  readonly selectModel: (state: ModuleState, value: string, among: readonly string[]) => string;
  /**
   * For the functions it `applies` to, writes a check without a fast form (see `hasFastForm`) as a call of its
   * micro-leaf, the full validator of that one check; absent when the mode writes every check itself.
   */
  readonly microLeaf?: { readonly applies: (fn: IrFunction) => boolean; readonly write: (writer: FunctionWriter, check: IrCheck, value: string) => void };
  /** The mode writes functions that keep or receive an evaluation record. */
  readonly records: boolean;
}

const REPORT_FAILURE = `ok = false; if (!${ALL}) { ${PATH}.length = pl; return false; }`;

function objectPresence(state: ModuleState, value: string, captured: readonly (readonly [key: string, local: string])[] = []): PresenceReader {
  // One Object.keys pass reads the declared keys of an object; the faster exact form of the JSON view.
  const locals = new Map(captured);
  const single = (): string => state.localHelper('isPresent');
  return {
    setup: captured.length > 0 ? [presentKeysSource(value, captured)] : [],
    present: key => { const local = locals.get(key); return local !== undefined ? `(${local} !== undefined)` : `${single()}(${value}, ${literal(key)})`; },
    read: key => locals.get(key) ?? `${value}[${literal(key)}]`,
  };
}

/** The full validator: a failed check pushes its issue, then returns at once unless all errors are wanted; a key is read through `isPresent`. */
const FULL_VALIDATOR: WriterMode = {
  fail: {
    start: [`const pl = ${PATH}.length;`, 'let ok = true;'],
    end: 'return ok;',
    issue: (fields, path) => [`${ISSUES}.push({ path: ${path}, ${fields} });`, REPORT_FAILURE],
    fail: () => REPORT_FAILURE,
    leaves: false,
  },
  presence: objectPresence,
  form: full => full,
  // Reads the declared keys; the checks after it loop over the key list for unknown keys and patterns.
  keyTest: (writer, { value, captured, needsKeys }) => {
    const presence = objectPresence(writer.state, value, captured);
    for (const line of presence.setup) writer.line(line);
    const keys = writer.fresh('keys');
    if (needsKeys) writer.line(`const ${keys} = ${writer.state.localHelper('definedKeys')}(${value});`);
    return { presence, count: `${keys}.length`, ...(needsKeys ? { keys } : {}) };
  },
  call: (writer, id, args) => {
    const target = writer.target(id);
    writer.calls.add(target);
    return callFunction(writer.functions[target], functionMark(target), args);
  },
  child: (writer, token, body) => {
    writer.line(`${PATH}.push(${token});`);
    body();
    writer.line(`${PATH}.pop();`);
  },
  selectModel: (state, value, among) => `${state.localHelper('selectedModel')}(${value}, ${JSON.stringify(among)})`,
  records: true,
};

/** `selectedModel` without a function made per call, and its list of codec ids made once. */
function modelOfSelection(state: ModuleState, value: string, among: readonly string[]): string {
  return `${state.localHelper('modelOf')}(${value}, ${state.constant('models', `Object.freeze(${JSON.stringify(among)})`)})`;
}

/**
 * The full validator of a module with fast checks: it selects a model class as the fast check does, so the module has
 * one selection helper, and a function with a fast check calls each micro-leaf in place, so each such check is written
 * once (F-129, F-164). Without fast checks the full validator is `FULL_VALIDATOR`, unchanged.
 */
function fullValidatorBeside(plan: FastPlan): WriterMode {
  return {
    ...FULL_VALIDATOR,
    selectModel: modelOfSelection,
    microLeaf: {
      applies: fn => plan.has(fn.id),
      write: (writer, check, value) => {
        const id = plan.microLeaf(check);
        writer.calls.add(id);
        writer.failWhen(`!${callFunction(plan.microLeafFunction(id), functionMark(id), { value, issues: ISSUES, all: ALL })}`);
      },
    },
  };
}

/**
 * The key test of the fast check (spec 5.2, F1): one `Object.keys` pass reads each declared key into its local, and,
 * when the object has unknown keys to test or keys to count, reads every key once, skips an `undefined` value, counts
 * the rest and tests each key that `properties` does not name. Without either, it reads only the declared keys, as the
 * full validator does, so a getter of another key never runs.
 */
function fastKeyTest(writer: FunctionWriter, { check, value, captured, visitsAdditional }: KeyTestRequest): KeyTest {
  const presence = objectPresence(writer.state, value, captured);
  const counts = check.minProperties !== undefined || check.maxProperties !== undefined;
  if (!counts && !visitsAdditional) {
    for (const line of presence.setup) writer.line(line);
    return { presence };
  }
  const count = counts ? writer.fresh('count') : undefined;
  const locals = [...captured.map(([, local]) => local), ...(count === undefined ? [] : [`${count} = 0`])];
  if (locals.length > 0) writer.line(`let ${locals.join(', ')};`);
  const key = writer.fresh('key');
  const item = writer.fresh('item');
  writer.open(`for (const ${key} of Object.keys(${value}))`);
  writer.line(`const ${item} = ${value}[${key}];`);
  writer.line(`if (${item} === undefined) continue;`);
  if (count !== undefined) writer.line(`${count}++;`);
  const named = new Set(check.properties.map(property => property.key));
  const capturedKeys = new Set(captured.map(([name]) => name));
  const additional = visitsAdditional ? check.additional : undefined;
  const cases = [
    ...captured.filter(([name]) => additional === undefined || named.has(name)).map(([name, local]) => `case ${literal(name)}: ${local} = ${item}; break;`),
    ...(additional === undefined ? [] : [...named].filter(name => !capturedKeys.has(name)).map(name => `case ${literal(name)}: break;`)),
  ];
  // A required or dependent key that `properties` does not name is still additional: `default` captures it, then tests it.
  const unnamed = captured.filter(([name]) => !named.has(name));
  if (cases.length > 0 || additional !== undefined) {
    writer.open(`switch (${key})`);
    for (const entry of cases) writer.line(entry);
    if (additional?.kind === 'forbid') {
      writer.line(`default: ${writer.mode.fail.fail()}`);
    } else if (additional !== undefined) {
      writer.open('default:');
      unnamed.forEach(([name, local], position) => writer.line(`${position === 0 ? '' : 'else '}if (${key} === ${literal(name)}) ${local} = ${item};`));
      writer.atChild(key, () => writer.schema(additional.schema, item));
      writer.close();
    }
    writer.close();
  }
  writer.close();
  return { presence, ...(count === undefined ? {} : { count }) };
}

/**
 * The fast check `is_X(v)` (spec 5.1): true exactly when the full validator reports no issue. A failed check returns
 * `false`; no path and no issue is built. A function with a fast check is called as `isN(v)`; any other through its full
 * validator (`leafPasses`), and a check without a fast form through a full validator of that one check (a micro-leaf).
 */
function fastCheckMode(plan: FastPlan): WriterMode {
  const leafCall = (writer: FunctionWriter, id: number, value: string): string => {
    writer.calls.add(id);
    return `${writer.state.localHelper('leafPasses')}(${functionMark(id)}, ${value})`;
  };
  return {
    fail: { start: [], end: 'return true;', issue: () => ['return false;'], fail: () => 'return false;', leaves: true },
    presence: objectPresence,
    form: (full, fast) => fast ?? full,
    keyTest: fastKeyTest,
    call: (writer, id, args) => {
      const target = writer.target(id);
      if (!plan.has(target)) return leafCall(writer, target, args.value);
      writer.fastCalls.add(target);
      return `${fastMark(target)}(${args.value})`;
    },
    child: (_writer, _token, body) => body(),
    selectModel: modelOfSelection,
    microLeaf: { applies: () => true, write: (writer, check, value) => writer.failWhen(`!${leafCall(writer, plan.microLeaf(check), value)}`) },
    records: false,
  };
}

/** A leaf check: the expression that is true when the value fails it, and the issue it then reports. */
interface LeafCheck {
  readonly fails: Text;
  /** The same test written cheaper for the fast check, where the full validator's form costs more than the verdict needs. */
  readonly fast?: Text;
  /** The fields of the issue after its path. */
  readonly issue: Text;
  /** The path of the issue; the current path by default. */
  readonly path?: string;
}

/** The issue fields of a limit; `limit` is a number, or an expression of the generated code. */
function limitFields(code: 'tooSmall' | 'tooBig', measure: string, limit: number | string, inclusive: boolean): string {
  return `code: ${literal(code)}, measure: ${literal(measure)}, limit: ${typeof limit === 'number' ? JSON.stringify(limit) : limit}, inclusive: ${inclusive}`;
}

/** A value of JSON that `===` compares as `jsonEqual` does. */
function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

/** Writes one function in the given mode: the mode decides what a failed check writes and how a declared key is read. */
class FunctionWriter {
  private readonly lines: string[] = [];
  private depth = 1;
  private counter = 0;
  /** The record that checks of the value being checked fill; undefined when this function keeps none, or while a child value is checked. */
  private record: string | undefined;

  /** Writes a check without a fast form as its micro-leaf, in a function the mode's `microLeaf` applies to. */
  private readonly microLeaf: ((writer: FunctionWriter, check: IrCheck, value: string) => void) | undefined;

  /** The full validators this one calls, by the id they have after forwarding. */
  public readonly calls = new Set<number>();
  /** The fast checks this one calls, by the id they have after forwarding. */
  public readonly fastCalls = new Set<number>();

  public constructor(
    public readonly state: ModuleState,
    public readonly functions: readonly IrFunction[],
    public readonly target: (id: number) => number,
    private readonly fn: IrFunction,
    public readonly mode: WriterMode,
  ) {
    // The record travels through the full validators' arguments, so a function that keeps or receives one is a leaf of the fast check.
    if (!mode.records && (fn.collects || fn.receives)) throw new Error(`The validator compiler writes no fast check for the schema function ${fn.id}: it keeps or receives an evaluation record.`);
    this.record = fn.collects || fn.receives ? EVALUATION : undefined;
    this.microLeaf = mode.microLeaf?.applies(fn) ? mode.microLeaf.write : undefined;
  }

  /** The body of the function, without its header line. */
  public write(): string {
    for (const start of this.mode.fail.start) this.line(start);
    if (this.fn.collects) this.line(`const ${EVALUATION} = ${this.state.localHelper('newEvaluation')}();`);
    else if (this.fn.receives) this.line(`const ${EVALUATION} = ${INHERITED} ?? ${this.state.localHelper('newEvaluation')}();`);
    this.schema(this.fn.body, VALUE);
    // A function that both keeps a record and receives one hands what it evaluated to its caller once it passed.
    if (this.fn.collects && this.fn.receives) this.line(`if (ok && ${INHERITED} !== undefined) ${this.state.localHelper('mergeEvaluation')}(${INHERITED}, ${EVALUATION});`);
    // A `false` schema has already left the function in a mode that leaves at a failure.
    if (this.fn.body.kind !== 'never' || !this.mode.fail.leaves) this.line(this.mode.fail.end);
    this.lines.push('}');
    return this.lines.join('\n');
  }

  public line(text: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}${text}`);
  }

  /** Opens a block; an empty `head` opens a bare scope. */
  public open(head: string): void {
    this.line(head === '' ? '{' : `${head} {`);
    this.depth++;
  }

  public close(): void {
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

  public fresh(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  /** A failed check with the issue `fields` at `path` (the current path by default), as the mode writes it. */
  private issue(fields: string, path = `${PATH}.slice()`): void {
    for (const statement of this.mode.fail.issue(fields, path)) this.line(statement);
  }

  /** A failed check whose issue a callee already reported, as the mode writes it. */
  private fail(): void {
    this.line(this.mode.fail.fail());
  }

  /** Fails the function when `test` holds, where a callee already reported the issue, or the mode builds none. */
  public failWhen(test: string): void {
    if (this.mode.fail.leaves) return this.line(`if (${test}) ${this.mode.fail.fail()}`);
    this.open(`if (${test})`);
    this.fail();
    this.close();
  }

  private leaf(check: LeafCheck): void {
    const test = text(this.mode.form(check.fails, check.fast));
    if (this.mode.fail.leaves) return this.failWhen(test);
    this.open(`if (${test})`);
    this.issue(text(check.issue), check.path);
    this.close();
  }

  /** The `tooSmall` and `tooBig` leaves of a lower and an upper limit on `measure`, whose value `actual` holds; `fast` writes each test cheaper. */
  private limitLeaves(measure: string, actual: Text, min: number | undefined, max: number | undefined, fast?: { readonly min: (limit: number) => string; readonly max: (limit: number) => string }): void {
    if (min !== undefined) this.leaf({ fails: () => `${text(actual)} < ${JSON.stringify(min)}`, ...(fast ? { fast: () => fast.min(min) } : {}), issue: limitFields('tooSmall', measure, min, true) });
    if (max !== undefined) this.leaf({ fails: () => `${text(actual)} > ${JSON.stringify(max)}`, ...(fast ? { fast: () => fast.max(max) } : {}), issue: limitFields('tooBig', measure, max, true) });
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
    return this.mode.call(this, id, args);
  }

  /** The function `id` applies to the same value in place: it fails this function when it fails, and fills this function's record. */
  private callInPlace(id: number, value: string): void {
    this.failWhen(`!${this.call(id, { value, issues: ISSUES, all: ALL, record: this.record })}`);
  }

  public schema(schema: IrSchema, value: string): void {
    if (schema.kind === 'never') this.issue("code: 'never'");
    else if (schema.kind === 'checks') this.checks(schema.checks, value);
  }

  /** True when the mode writes `check` itself rather than as a micro-leaf. */
  private writes(check: IrCheck): boolean {
    return this.microLeaf === undefined || hasFastForm(check);
  }

  private checks(checks: readonly IrCheck[], value: string): void {
    for (let position = 0; position < checks.length; position++) {
      const check = checks[position];
      const next = checks[position + 1];
      // A value that is not an object has already failed the type check, so the object keywords have nothing to test.
      if (check.kind === 'type' && check.names.every(name => name === 'object') && next?.kind === 'object' && this.writes(next)) {
        this.objectOrTypeIssue(check, next, value);
        position++;
      } else {
        this.check(check, value);
      }
    }
  }

  /** Runs `body` for the child `token` of the current value, as the mode writes a child; the child has its own evaluation, so no record is filled. */
  public atChild(token: string, body: () => void): void {
    const record = this.record;
    this.record = undefined;
    this.mode.child(this, token, body);
    this.record = record;
  }

  private check(check: IrCheck, value: string): void {
    if (this.microLeaf !== undefined && !hasFastForm(check)) return this.microLeaf(this, check, value);
    switch (check.kind) {
      case 'type':
        if (check.names.includes('object')) this.state.localHelper('isObject');
        return this.leaf({ fails: `!(${check.names.map(name => TYPE_TESTS[name](value)).join(' || ')})`, issue: `code: 'type', expected: ${JSON.stringify(check.names)}` });
      case 'literal': {
        const values = (): string => this.state.constant('lit', `Object.freeze(/*#__PURE__*/ JSON.parse(${literal(JSON.stringify(check.values))}))`);
        const equal = (item: string): string => `${this.state.runtimeHelper('jsonEqual')}(${value}, ${item})`;
        return this.leaf({
          fails: () => (check.values.length === 1 ? `!${equal(`${values()}[0]`)}` : `!${values()}.some(item => ${equal('item')})`),
          // `jsonEqual` starts with `===`, and a JSON primitive equals nothing else, so `===` decides for a primitive.
          // An empty `enum` allows no value.
          fast: () => (check.values.length === 0 ? 'true' : check.values.map((item, position) => (isPrimitive(item) ? `${value} !== ${JSON.stringify(item)}` : `!${equal(`${values()}[${position}]`)}`)).join(' && ')),
          issue: () => `code: 'literal', expected: ${values()}`,
        });
      }
      case 'format':
        return this.leaf({
          fails: () => `!${this.state.runtimeHelper('checkFormat')}(${literal(check.format)}, ${value})`,
          // The format's test, looked up once when the module loads.
          fast: () => `!${this.state.constant('format', `${this.state.runtimeHelper('formatTest')}(${literal(check.format)})`)}(${value})`,
          issue: `code: 'format', format: ${literal(check.format)}`,
        });
      case 'date':
        return this.leaf({ fails: `!(${value} instanceof Date) || !Number.isFinite(${value}.getTime())`, issue: "code: 'type', expected: ['Date']" });
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
        return this.leaf({ fails: this.call(check.fn, { value, issues: '[]', all: 'false' }), issue: "code: 'not'" });
      case 'conditional': return this.conditionalCheck(check, value);
      case 'dependentSchemas': {
        this.state.localHelper('isObject');
        const presence = this.mode.presence(this.state, value);
        this.open(`if (isObject(${value}))`);
        for (const { trigger, fn } of check.entries) {
          this.open(`if (${presence.present(trigger)})`);
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
    this.line(`const ${selected} = ${this.mode.selectModel(this.state, value, check.among)};`);
    const expected = check.of === undefined ? 'undefined' : literal(check.of);
    this.leaf({
      fails: check.required || check.of === undefined ? `${selected} !== ${expected}` : `${selected} !== undefined && ${selected} !== ${expected}`,
      issue: `code: 'instance', model: ${literal(check.of ?? check.among[0])}`,
    });
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
        this.leaf({ fails: `${result} !== true`, issue: `code: 'custom', ...(typeof ${result} === 'string' && ${result}.length > 0 ? { reason: ${result} } : {})` });
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
    // The full validator counts the code points once, in a local written before the first limit that reads it.
    let counted: string | undefined;
    const length = (): string => {
      if (counted === undefined) {
        counted = this.fresh('n');
        this.line(`const ${counted} = ${this.state.runtimeHelper('codePointLength')}(${value});`);
      }
      return counted;
    };
    // A code point is one or two UTF-16 units, so the fast check counts them only where the length cannot decide.
    const codePoints = (): string => `${this.state.runtimeHelper('codePointLength')}(${value})`;
    this.limitLeaves('length', length, check.minLength, check.maxLength, {
      min: limit => `${value}.length < ${JSON.stringify(2 * limit)} && ${codePoints()} < ${JSON.stringify(limit)}`,
      max: limit => `${value}.length > ${JSON.stringify(limit)} && ${codePoints()} > ${JSON.stringify(limit)}`,
    });
    if (check.pattern !== undefined) {
      const expression = this.state.constant('pattern', `new RegExp(${literal(check.pattern)}, 'u')`);
      this.leaf({ fails: `!${expression}.test(${value})`, issue: `code: 'pattern', pattern: ${literal(check.pattern)}` });
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
      this.leaf({ fails: `${value} ${operator} ${JSON.stringify(limit)}`, issue: limitFields(code, 'value', limit, inclusive) });
    }
    if (check.multipleOf !== undefined) this.leaf({ fails: `!${this.state.localHelper('isMultipleOf')}(${value}, ${JSON.stringify(check.multipleOf)})`, issue: `code: 'multipleOf', divisor: ${JSON.stringify(check.multipleOf)}` });
    this.close();
  }

  private arrayCheck(check: IrArray, value: string): void {
    this.block(`if (Array.isArray(${value}))`, () => {
      this.limitLeaves('items', `${value}.length`, check.minItems, check.maxItems);
      if (check.closed) this.leaf({ fails: `${value}.length > ${check.prefixItems.length}`, issue: limitFields('tooBig', 'items', check.prefixItems.length, true) });
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
        // With all errors the search stops at the first duplicate pair; a mode that leaves at a failure needs no label.
        const label = this.mode.fail.leaves ? undefined : this.fresh('unique');
        const jsonEqual = this.state.runtimeHelper('jsonEqual');
        this.open(`${label === undefined ? '' : `${label}: `}for (let ${first} = 0; ${first} < ${value}.length - 1; ${first}++)`);
        this.open(`for (let ${second} = ${first} + 1; ${second} < ${value}.length; ${second}++)`);
        // An `undefined` item and a hole are `null` in the JSON view, as `jsonEqual` reads nested items.
        this.open(`if (${jsonEqual}(${value}[${first}] ?? null, ${value}[${second}] ?? null))`);
        this.issue(`code: 'unique', indexes: [${first}, ${second}]`);
        if (label !== undefined) this.line(`break ${label};`);
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
    this.limitLeaves('matches', count, contains.min > 0 ? contains.min : undefined, contains.max);
  }

  private objectCheck(check: IrObject, value: string): void {
    this.state.localHelper('isObject');
    this.block(`if (${TYPE_TESTS.object(value)})`, () => this.objectKeywords(check, value));
  }

  /** The type check that requires an object, and the object keywords in its `else`: the value is tested once. */
  private objectOrTypeIssue(type: IrType, check: IrObject, value: string): void {
    this.state.localHelper('isObject');
    // A mode that leaves at a failure needs no `else`: the keywords follow the type test.
    if (this.mode.fail.leaves) {
      this.failWhen(`!${TYPE_TESTS.object(value)}`);
      return this.objectKeywords(check, value);
    }
    this.open(`if (!${TYPE_TESTS.object(value)})`);
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
    const marks = this.record !== undefined;
    const declared = new Set([
      ...check.required,
      ...check.dependentRequired.flatMap(({ trigger, keys }) => keys.length > 0 ? [trigger, ...keys] : []),
      ...check.properties.filter(property => property.schema.kind !== 'always' || marks).map(property => property.key),
    ]);
    const captured = [...declared].map(key => [key, this.fresh('present')] as const);
    // A key that matches a pattern is not "additional" even when the pattern's schema accepts everything.
    const patterns = check.patternProperties.map(entry => ({ entry, expression: this.state.constant('pattern', `new RegExp(${literal(entry.pattern)}, 'u')`) }));
    const patternsToRun = patterns.filter(({ entry }) => entry.schema.kind !== 'always' || marks);
    const visitsAdditional = check.additional !== undefined && (check.additional.kind === 'forbid' || check.additional.schema.kind !== 'always');
    const needsKeys = check.minProperties !== undefined || check.maxProperties !== undefined || patternsToRun.length > 0 || visitsAdditional || check.propertyNames !== undefined;
    const { presence, count, keys } = this.mode.keyTest(this, { check, value, captured, needsKeys, visitsAdditional });
    // The key test makes the key list or the count for each check below that reads it.
    const listed = (what: string | undefined): string => {
      if (what === undefined) throw new Error('The key test of this validator mode left no key list or count for an object check that reads it.');
      return what;
    };
    this.limitLeaves('properties', () => listed(count), check.minProperties, check.maxProperties);
    const required = (key: string): LeafCheck => ({ fails: `!${presence.present(key)}`, issue: `code: 'required', key: ${literal(key)}`, path: `[...${PATH}, ${literal(key)}]` });
    for (const key of check.required) this.leaf(required(key));
    for (const { trigger, keys: dependents } of check.dependentRequired) {
      if (dependents.length === 0) continue;
      this.open(`if (${presence.present(trigger)})`);
      for (const key of dependents) this.leaf(required(key));
      this.close();
    }
    // Ahead of `properties`: with fail-fast the first issue is the object's own unknown key. A key test without a key list ran it.
    if (check.additional && visitsAdditional && keys !== undefined) {
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
      this.open(`if (${presence.present(property.key)})`);
      this.mark(record => `${record}.keys.add(${literal(property.key)});`);
      if (schema.kind !== 'always') {
        const member = this.fresh('member');
        this.line(`const ${member} = ${presence.read(property.key)};`);
        this.atChild(literal(property.key), () => this.schema(schema, member));
      }
      this.close();
    }
    if (patternsToRun.length > 0) {
      const key = this.fresh('key');
      this.open(`for (const ${key} of ${listed(keys)})`);
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
      this.open(`for (const ${key} of ${listed(keys)})`);
      this.leaf({ fails: `!${this.call(check.propertyNames, { value: key, issues: '[]', all: 'false' })}`, issue: `code: 'invalidKey', key: ${key}` });
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
      if (schema.kind === 'never') this.leaf({ fails: `${unevaluated} > 0`, issue: limitFields('tooBig', 'items', `${value}.length - ${unevaluated}`, true) });
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
    if (!check.exactlyOne) return this.leaf({ fails: `!(${check.branches.map(attempt).join(' || ')})`, issue: "code: 'union', matched: 0" });
    const matched = this.fresh('matched');
    this.line(`let ${matched} = 0;`);
    // Two matches already decide the outcome, so later branches are not run.
    check.branches.forEach((fn, position) => this.line(`if (${position === 0 ? '' : `${matched} < 2 && `}${attempt(fn)}) ${matched}++;`));
    this.leaf({ fails: `${matched} !== 1`, issue: `code: 'union', matched: ${matched}` });
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
    this.leaf({ fails: check.exactlyOne ? `${matched} !== 1` : `${matched} === 0`, issue: `code: 'union', matched: ${matched}` });
  }

  /**
   * The tag selects the branch; only that branch's issues are reported, and an unknown tag is a `literal` issue on the
   * tag property. The tag is read once; the first branch whose list holds it is selected, as a tag lies in one list.
   */
  private discriminatedUnion(check: IrUnion, discriminator: IrDiscriminator, value: string): void {
    this.state.localHelper('isObject');
    const presence = this.mode.presence(this.state, value);
    const property = literal(discriminator.property);
    const jsonEqual = (): string => this.state.runtimeHelper('jsonEqual');
    const tags = (): string => this.state.constant('tags', `Object.freeze(/*#__PURE__*/ JSON.parse(${literal(JSON.stringify(discriminator.tags))}))`);
    const tag = this.fresh('tag');
    const selected = this.fresh('branch');
    const read = this.mode.form(
      () => `isObject(${value}) && ${presence.present(discriminator.property)} ? ${presence.read(discriminator.property)} : undefined`,
      `isObject(${value}) ? (${presentValueSource(value, property, `${value}[${property}]`)}) : undefined`,
    );
    this.line(`const ${tag} = ${text(read)};`);
    // The fast check compares a primitive tag with `===`, which `jsonEqual` starts with, and makes no function per call.
    const matches = (position: number): string => discriminator.tags[position]
      .map((item, index) => (isPrimitive(item) ? `${tag} === ${JSON.stringify(item)}` : `${jsonEqual()}(${tag}, ${tags()}[${position}][${index}])`))
      .join(' || ') || 'false';
    const selection = this.mode.form(
      () => `${tags()}.findIndex(list => list.some(item => ${jsonEqual()}(${tag}, item)))`,
      () => `${discriminator.tags.map((_, position) => `${matches(position)} ? ${position} : `).join('')}-1`,
    );
    this.line(`const ${selected} = ${text(selection)};`);
    check.branches.forEach((fn, position) => {
      this.open(`if (${selected} === ${position})`);
      this.callInPlace(fn, value);
      this.close();
    });
    this.leaf({
      fails: `${selected} < 0`,
      issue: () => `code: 'literal', expected: ${this.state.constant('lit', `Object.freeze(/*#__PURE__*/ JSON.parse(${literal(JSON.stringify(discriminator.tags.flat()))}))`)}`,
      path: `[...${PATH}, ${property}]`,
    });
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

/** Every check of a schema, the checks of the schemas inlined in them included. */
function visitChecks(schema: IrSchema, visit: (check: IrCheck) => void): void {
  if (schema.kind !== 'checks') return;
  for (const check of schema.checks) {
    visit(check);
    switch (check.kind) {
      case 'array':
        for (const item of check.prefixItems) visitChecks(item, visit);
        if (check.items !== undefined) visitChecks(check.items, visit);
        break;
      case 'object':
        for (const property of check.properties) visitChecks(property.schema, visit);
        for (const entry of check.patternProperties) visitChecks(entry.schema, visit);
        if (check.additional?.kind === 'schema') visitChecks(check.additional.schema, visit);
        break;
      case 'allOf':
        for (const branch of check.branches) visitChecks(branch, visit);
        break;
      case 'unevaluatedProperties':
      case 'unevaluatedItems':
        visitChecks(check.schema, visit);
        break;
      case 'type': case 'literal': case 'format': case 'string': case 'number': case 'date': case 'instance': case 'call': case 'union':
      case 'not': case 'conditional': case 'dependentSchemas': case 'validation':
        break;
    }
  }
}

/** The functions a check runs: the edges of the IR call graph. */
function calledFunctions(check: IrCheck): readonly number[] {
  switch (check.kind) {
    case 'call':
    case 'not':
      return [check.fn];
    case 'union': return check.branches;
    case 'conditional': return [check.if, ...(check.then === undefined ? [] : [check.then]), ...(check.else === undefined ? [] : [check.else])];
    case 'dependentSchemas': return check.entries.map(entry => entry.fn);
    case 'array': return check.contains === undefined ? [] : [check.contains.fn];
    case 'object': return check.propertyNames === undefined ? [] : [check.propertyNames];
    case 'validation': return check.fn === undefined ? [] : [check.fn];
    case 'type': case 'literal': case 'format': case 'string': case 'number': case 'allOf': case 'date': case 'instance':
    case 'unevaluatedProperties': case 'unevaluatedItems':
      return [];
  }
}

/** The functions whose IR call graph reaches a validation function (spec 5.1 rule 7). */
function reachingValidation(functions: readonly IrFunction[]): ReadonlySet<number> {
  const callers = new Map<number, number[]>();
  const reaching = new Set<number>();
  for (const fn of functions) {
    visitChecks(fn.body, check => {
      if (check.kind === 'validation') reaching.add(fn.id);
      for (const callee of calledFunctions(check)) callers.set(callee, [...(callers.get(callee) ?? []), fn.id]);
    });
  }
  const pending = [...reaching];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const caller of callers.get(id) ?? []) {
      if (reaching.has(caller)) continue;
      reaching.add(caller);
      pending.push(caller);
    }
  }
  return reaching;
}

/**
 * True when the fast check writes `check` itself; any other check is a micro-leaf (spec 5.4 b), so a kind without a
 * form, a new one included, is never skipped. `if`, `dependentSchemas`, `contains`, `patternProperties` and
 * `propertyNames` get their forms in a later step; `unevaluated*` and validation functions have none.
 */
function hasFastForm(check: IrCheck): boolean {
  switch (check.kind) {
    case 'type': case 'literal': case 'format': case 'date': case 'string': case 'number': case 'instance': case 'call': case 'allOf':
    // Branches and `not` call exact checks (spec 5.4 c), so their verdicts count as the full validator's do.
    case 'union': case 'not':
      return true;
    case 'array': return check.contains === undefined;
    // One IR check is one unit: an object check with either keyword is one micro-leaf as a whole.
    case 'object': return check.patternProperties.length === 0 && check.propertyNames === undefined;
    default: return false;
  }
}

/**
 * True when `check` is a fast form that decides something itself, not one that only passes the value to micro-leaves:
 * `allOf` through its branches, a union, `not` and `$ref` through the functions they call (spec 5.4 a).
 */
function decidesFast(check: IrCheck, has: (id: number) => boolean): boolean {
  if (!hasFastForm(check)) return false;
  switch (check.kind) {
    case 'allOf': return check.branches.some(branch => branch.kind === 'never' || (branch.kind === 'checks' && branch.checks.some(inner => decidesFast(inner, has))));
    case 'union': return check.branches.some(has);
    case 'not': case 'call': return has(check.fn);
    default: return true;
  }
}

/**
 * True when a fast check of `body` pays: a check of it decides something itself, and its top-level object or array
 * check is not a micro-leaf, which a failing value would run twice for nothing (spec 5.4 a).
 */
function fastBody(body: IrSchema, has: (id: number) => boolean): boolean {
  if (body.kind !== 'checks') return true;
  return body.checks.some(check => decidesFast(check, has)) && !body.checks.some(check => (check.kind === 'object' || check.kind === 'array') && !hasFastForm(check));
}

/**
 * Which functions get a fast check, and the micro-leaves the fast checks call. A function gets one when it keeps and
 * receives no evaluation record (spec 5.4, the record travels through full validators), its IR call graph reaches no
 * validation function, so each predicate runs once per conversion (rule 7), and its body pays (`fastBody`), counting a
 * call only to a function that has a fast check itself.
 */
class FastPlan {
  private readonly fast = new Set<number>();
  private readonly micro = new Map<IrCheck, IrFunction>();

  public constructor(private readonly functions: readonly IrFunction[]) {
    const reaching = reachingValidation(functions);
    const candidates = functions.filter(fn => !fn.collects && !fn.receives && !reaching.has(fn.id));
    const has = (id: number): boolean => this.fast.has(id);
    for (let grew = true; grew;) {
      grew = false;
      for (const fn of candidates) {
        if (this.fast.has(fn.id) || !fastBody(fn.body, has)) continue;
        this.fast.add(fn.id);
        grew = true;
      }
    }
  }

  public has(id: number): boolean {
    return this.fast.has(id);
  }

  /** The id of the function that is `check` alone, written as a full validator; the same check gets the same function. */
  public microLeaf(check: IrCheck): number {
    const known = this.micro.get(check);
    if (known !== undefined) return known.id;
    const fn: IrFunction = { id: this.functions.length + this.micro.size, body: { kind: 'checks', checks: [check] }, collects: false, receives: false };
    this.micro.set(check, fn);
    return fn.id;
  }

  public microLeafFunction(id: number): IrFunction {
    const fn = [...this.micro.values()].find(entry => entry.id === id);
    if (fn === undefined) throw new Error(`The validator compiler has no micro-leaf ${id}.`);
    return fn;
  }

  public microLeaves(): readonly IrFunction[] {
    return [...this.micro.values()];
  }
}

/** The fast check of a function as text, with what it calls. */
interface WrittenFastCheck {
  /** The body, with the full validators it calls as `functionMark`s and the fast checks as `fastMark`s. */
  readonly body: string;
  readonly calls: ReadonlySet<number>;
  readonly fastCalls: ReadonlySet<number>;
}

interface WrittenFunction {
  readonly id: number;
  readonly parameters: string;
  /** The body, with the functions it calls as marks. */
  readonly body: string;
  readonly calls: ReadonlySet<number>;
  /** The fast check, for a function that has one. */
  readonly fast?: WrittenFastCheck;
}

function writeFunction(state: ModuleState, module: IrModule, target: (id: number) => number, fn: IrFunction, mode: WriterMode): WrittenFunction {
  const writer = new FunctionWriter(state, module.functions, target, fn, mode);
  const body = writer.write();
  return { id: fn.id, parameters: functionParameters(fn), body, calls: writer.calls };
}

function writeFastCheck(state: ModuleState, module: IrModule, target: (id: number) => number, fn: IrFunction, mode: WriterMode): WrittenFastCheck {
  const writer = new FunctionWriter(state, module.functions, target, fn, mode);
  return { body: writer.write(), calls: writer.calls, fastCalls: writer.fastCalls };
}

/**
 * Groups the functions that behave alike: those with the same parameters whose bodies, and fast checks, are the same
 * text once each call names the group of its callee. Groups start as one and split until stable, so recursive functions
 * that mirror each other (a model and its wire form) end up together. A group is named by its lowest id.
 */
function groupFunctions(written: readonly WrittenFunction[]): ReadonlyMap<number, number> {
  let groups = new Map<number, number>(written.map(entry => [entry.id, 0]));
  let size = 1;
  for (;;) {
    const keys = new Map<string, number>();
    const next = new Map<number, number>();
    const named = (text: string): string => text
      .replace(FUNCTION_MARK, (_, id: string) => functionName(groups.get(Number(id)) ?? -1))
      .replace(FAST_MARK, (_, id: string) => fastName(functionName(groups.get(Number(id)) ?? -1)));
    for (const entry of written) {
      const key = `${groups.get(entry.id)}\n${entry.parameters}\n${named(entry.body)}${entry.fast === undefined ? '' : `\n${named(entry.fast.body)}`}`;
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

/** The ids reachable from `start` through `next`. */
function reachable(start: Iterable<number>, next: (id: number) => Iterable<number>): Set<number> {
  const reached = new Set<number>();
  const pending = [...start];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...next(id));
  }
  return reached;
}

/**
 * Emits the module: one function per distinct behavior and one exported wrapper per root, named by `exportNames`.
 * Every check is written once: a forwarding function, and a function the same as another, are not emitted, and
 * their callers call the one that is. With `fastPath`, each root that has a fast check (see `FastPlan`) also exports
 * `is_X`, and only the fast checks those reach are written (spec 5.1 rule 9).
 */
export function emit(module: IrModule, options: EmitOptions): EmitResult {
  const target = forwardingTarget(module.functions);
  const fastPath = options.fastPath;
  const plan = fastPath === true || (fastPath instanceof Set && fastPath.size > 0) ? new FastPlan(module.functions) : undefined;
  const wantsFastCheck = (name: string): boolean => fastPath === true || (fastPath instanceof Set && fastPath.has(name));
  const fastMode = plan === undefined ? undefined : fastCheckMode(plan);
  const fullMode = plan === undefined ? FULL_VALIDATOR : fullValidatorBeside(plan);
  const hasFastCheck = (id: number): boolean => plan?.has(id) ?? false;
  // First pass: every function as text, to learn which of those the roots reach are the same.
  const survey = new ModuleState();
  survey.importValidations(module.validations);
  const written = new Map(module.functions.filter(fn => target(fn.id) === fn.id).map(fn => [fn.id, {
    ...writeFunction(survey, module, target, fn, fullMode),
    ...(fastMode !== undefined && hasFastCheck(fn.id) ? { fast: writeFastCheck(survey, module, target, fn, fastMode) } : {}),
  }] as const));
  // The micro-leaves the fast checks call; each is a full validator of one check, which makes no micro-leaf.
  const microLeaves = new Map((plan?.microLeaves() ?? []).map(fn => [fn.id, fn] as const));
  for (const fn of microLeaves.values()) written.set(fn.id, writeFunction(survey, module, target, fn, fullMode));
  const functionAt = (id: number): IrFunction => {
    const fn = id < module.functions.length ? module.functions[id] : microLeaves.get(id);
    if (fn === undefined) throw new Error(`The validator compiler has no schema function ${id}.`);
    return fn;
  };
  const fastRootExports = module.exports.filter(({ name, fn }) => wantsFastCheck(name) && hasFastCheck(target(fn)));
  const fastRoots = fastRootExports.map(({ fn }) => target(fn));
  const fastReached = reachable(fastRoots, id => written.get(id)?.fast?.fastCalls ?? []);
  const reached = reachable(
    [...module.exports.map(({ fn }) => target(fn)), ...[...fastReached].flatMap(id => [...(written.get(id)?.fast?.calls ?? [])])],
    id => written.get(id)?.calls ?? [],
  );
  const representative = groupFunctions([...written.values()].filter(entry => reached.has(entry.id)));
  const kept = [...new Set(representative.values())].sort((first, second) => first - second);
  const names = new Map(kept.map((id, index) => [id, functionName(index, functionAt(id).name)] as const));
  // A mark holds the id after forwarding.
  const markName = (id: number): string => {
    const name = names.get(representative.get(id) ?? -1);
    if (name === undefined) throw new Error(`The validator compiler has no emitted function for the schema function ${id}.`);
    return name;
  };
  const nameOf = (id: number): string => markName(target(id));
  const resolved = (body: string): string => body
    .replace(FUNCTION_MARK, (_, called: string) => markName(Number(called)))
    .replace(FAST_MARK, (_, called: string) => fastName(markName(Number(called))));
  // Second pass: only the functions that stay, so the constants and helpers are those they use.
  const state = new ModuleState();
  state.importValidations(module.validations);
  const functions = kept.map(id => {
    const { parameters, body } = writeFunction(state, module, target, functionAt(id), fullMode);
    return `function ${names.get(id)}(${parameters}) {\n${resolved(body)}`;
  });
  const fastKept = [...new Set([...fastReached].map(id => representative.get(id) ?? id))].sort((first, second) => first - second);
  const fastFunctions = fastMode === undefined ? [] : fastKept.map(id => `function ${fastName(markName(id))}(${VALUE}) {\n${resolved(writeFastCheck(state, module, target, module.functions[id], fastMode).body)}`);
  const exported = exportNames(module.exports.map(({ name }) => name));
  const exportName = (name: string): string => {
    const known = exported.get(name);
    if (known === undefined) throw new Error(`The validator compiler has no export name for the root ${JSON.stringify(name)}.`);
    return known;
  };
  const wrappers = module.exports.map(({ name, fn }) => [
    options.typed
      ? `export function ${exportName(name)}(value: unknown, all: boolean): readonly SchemaIssue[] {`
      : `export function ${exportName(name)}(value, all) {`,
    '  const issues = [];',
    `  ${callFunction(module.functions[target(fn)], nameOf(fn), { value: 'value', path: '[]', issues: 'issues', all: 'all' })};`,
    '  return issues;',
    '}',
  ].join('\n'));
  const fastExports = new Map(fastRootExports.map(({ name }) => [name, fastExportName(exportName(name))] as const));
  // The fast check itself is the export: a valid value takes no extra call.
  const fastWrappers = fastRootExports.map(({ name, fn }) => options.typed
    ? `export const ${fastExportName(exportName(name))}: (value: unknown) => boolean = ${fastName(nameOf(fn))};`
    : `export const ${fastExportName(exportName(name))} = ${fastName(nameOf(fn))};`);
  return {
    source: [
      ...(options.typed ? [`import type { SchemaIssue } from ${literal(options.runtimeModule)};`] : []),
      ...state.prelude(options.runtimeModule),
      ...functions,
      ...fastFunctions,
      ...wrappers,
      ...fastWrappers,
      '',
    ].join('\n'),
    fastExports,
  };
}
