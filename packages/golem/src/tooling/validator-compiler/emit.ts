import type { IrArray, IrCheck, IrDiscriminator, IrFunction, IrInstance, IrModule, IrNumber, IrObject, IrPatternProperty, IrSchema, IrString, IrType, IrTypeName, IrUnion, IrValidation, IrValidationImport } from './ir.js';

import { MODEL_CODEC_IDS_KEY } from '../../schema-keywords.js';
import {
  code, helper, helperDefinitions, helperName, identifier as identifierCode, indented, join, literal as literalCode, nameOf, nameSlot, NameTable, render, runtimeImports,
  type Code, type Helper, type InputSlot, type NameSlot,
} from '../code.js';
import { compareText } from '../generator-api.js';
import { rt, rtType } from '../rt.js';
import { instanceFieldsCode, presentKeysCode, presentValueCode } from '../union-conversion.js';

interface EmitOptions {
  /** The module specifier the generated file imports its runtime helpers from. */
  readonly runtimeModule: string;
  /** Types each exported validator as a `Validator`, for a TypeScript file. */
  readonly typed?: boolean;
  /** Also writes the boolean fast check `is_X` beside `validate_X`, for each root, or each root named, that has one (see `FastPlan`). */
  readonly fastPath?: boolean | ReadonlySet<string>;
}

interface EmitResult {
  readonly source: string;
  /** The name each root's fast check is exported under, by root name; only roots that have one. */
  readonly fastExports: ReadonlyMap<string, string>;
}

type LocalHelper = 'isPresent' | 'definedKeys' | 'readAll' | 'isObject' | 'instanceFields' | 'isInstanceState' | 'isMultipleOf' | 'hashedId' | 'selectedModel' | 'modelOf' | 'newEvaluation' | 'mergeEvaluation' | 'leafPasses';

// Parameters of every generated function: the value, the path stack, the issue list and the all-errors flag,
// then, for a function that receives an evaluation record (see `IrFunction`), the caller's record. Every call and
// header goes through `functionParameters` and `callFunction`, so a change to the parameter list is made in one place.
const VALUE = identifierCode('v');
const PATH = identifierCode('p');
const NEWLINE = code`\n`;
const COMMA = code`, `;
const runtime = rt['validation-runtime'];
const ISSUES = identifierCode('i');
const ALL = identifierCode('a');
const INHERITED = identifierCode('e');
// The record a function keeps or fills, and what it holds.
const EVALUATION = identifierCode('r');

function functionParameters(fn: IrFunction): Code {
  return join([VALUE, PATH, ISSUES, ALL, ...(fn.receives ? [INHERITED] : [])], COMMA);
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
  const names = [...new Set(rootNames)].sort(compareText);
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
 * The name of the function written at position `index` among the functions the module keeps (`f3_User`), or of its fast
 * check (`is3_User`). The index keeps names unique; the schema's name, when it has one, shows in stack traces and profiles.
 */
function functionName(index: number, schemaName: string | undefined, fast: boolean): string {
  const prefix = fast ? 'is' : 'f';
  return schemaName === undefined ? `${prefix}${index}` : `${prefix}${index}_${identifier(schemaName).slice(0, NAME_LIMIT)}`;
}

/**
 * The name slot of each function and of its fast check. A body names a callee by its slot, because the name depends on
 * which functions turn out to be one: the survey writes every function against its own slots, and the final pass writes
 * each call against the slots of the function that stays (see `groupFunctions`), so a name has one slot.
 */
class FunctionSlots {
  private readonly full: readonly NameSlot[];
  private readonly fast: readonly NameSlot[];
  private readonly owners = new Map<NameSlot, { readonly id: number; readonly fast: boolean }>();

  public constructor(functions: readonly IrFunction[]) {
    this.full = functions.map(fn => nameSlot(`function ${fn.id}`));
    this.fast = functions.map(fn => nameSlot(`fast check ${fn.id}`));
    functions.forEach((fn, id) => {
      this.owners.set(this.full[id], { id, fast: false });
      this.owners.set(this.fast[id], { id, fast: true });
    });
  }

  public of(id: number, fast: boolean): NameSlot {
    return (fast ? this.fast : this.full)[id];
  }

  /** The function a slot belongs to, and whether it is the slot of its fast check. */
  public owner(slot: NameSlot): { readonly id: number; readonly fast: boolean } | undefined {
    return this.owners.get(slot);
  }
}

/** The slot a call names: the function `id` after forwarding, or its fast check. */
type CalleeSlot = (id: number, fast: boolean) => NameSlot;

interface CallArguments {
  readonly value: Code;
  readonly path?: Code;
  readonly issues: Code;
  readonly all: Code;
  /** The record to hand to the callee; dropped when the callee takes none. */
  readonly record?: Code;
}

function callFunction(callee: IrFunction, name: Code, args: CallArguments): Code {
  const record = callee.receives && args.record !== undefined ? [args.record] : [];
  return code`${name}(${join([args.value, args.path ?? PATH, args.issues, args.all, ...record], COMMA)})`;
}

/** A helper function of a generated module: the file holds its definition once, where the code that names it asks for it. */
function localHelper(id: LocalHelper, rank: number, define: (self: Code) => Code): Helper {
  const made: Helper = helper(id, () => define(helperName(made)), rank);
  return made;
}

/** The name of a local helper, and the request that the file defines it. */
function localName(name: LocalHelper): Code {
  return helperName(HELPERS[name]);
}

/** True when the registered codec id `registered` is the model `id`, in the code of `selectedModel` and `modelOf`. */
function modelIdMatches(): Code {
  const hashedId = localName('hashedId');
  return code`registered === id
    || (!${hashedId}.test(id) && registered.length === id.length + 9 && registered.startsWith(id + "_") && ${hashedId}.test(registered))`;
}

// The rank of a helper is its place in the module: helpers come in this order, after the helpers their definitions name.
const HELPERS: Readonly<Record<LocalHelper, Helper>> = {
  // The JSON view: a key is present when it is own, enumerable and not `undefined`, as `JSON.stringify` writes it. A
  // model's optional field may be set to `undefined` and JSON has no such value.
  definedKeys: localHelper('definedKeys', 0, self => code`const ${self} = value => Object.keys(value).filter(key => value[key] !== undefined);`),
  // The failure of a fast check whose key test left the values unread reads them as the full validator does, then fails.
  readAll: localHelper('readAll', 1, self => code`function ${self}(value, keys) { for (const key of keys) value[key]; }`),
  isPresent: localHelper('isPresent', 2, self => code`const ${self} = (value, key) => Object.prototype.propertyIsEnumerable.call(value, key) && value[key] !== undefined;`),
  isObject: localHelper('isObject', 3, self => code`const ${self} = value => typeof value === 'object' && value !== null && !Array.isArray(value);`),
  // An own key that the value's own model does not declare is program state, never an unknown key (see `instanceFieldsCode`).
  instanceFields: localHelper('instanceFields', 4, () => instanceFieldsCode()),
  isInstanceState: localHelper('isInstanceState', 5, self => code`function ${self}(value, key) { const fields = ${localName('instanceFields')}(value); return fields !== undefined && !fields.includes(key); }`),
  // The quotient of two doubles is off by rounding (0.3 / 0.1), so a quotient within a few ulps of a non-zero
  // whole number counts. An infinite quotient falls back to the exact remainder.
  isMultipleOf: localHelper('isMultipleOf', 6, self => join([
    code`function ${self}(value, divisor) {`,
    code`  const quotient = value / divisor;`,
    code`  if (!Number.isFinite(quotient)) return value % divisor === 0;`,
    code`  if (Number.isInteger(quotient)) return true;`,
    code`  const nearest = Math.round(quotient);`,
    code`  return nearest !== 0 && Math.abs(quotient - nearest) <= 4 * Number.EPSILON * Math.abs(nearest);`,
    code`}`,
  ], NEWLINE)),
  hashedId: localHelper('hashedId', 7, self => code`const ${self} = /_[0-9a-f]{8}$/;`),
  // The registered model class a value is an instance of, as `golemModelInstance` reads it. The symbol key is
  // `MODEL_CODEC_IDS_KEY`, which object-codec.ts registers under: the generated module imports nothing that registers classes. The most derived
  // registered prototype on the chain wins. A hashed codec id (`Name_1a2b3c4d`) matches exactly; an unhashed name also
  // matches the hashed ids of that name.
  selectedModel: localHelper('selectedModel', 8, self => join([
    code`function ${self}(value, among) {`,
    code`  if (typeof value !== 'object' || value === null) return undefined;`,
    code`  const key = Symbol.for(${literalCode(MODEL_CODEC_IDS_KEY)});`,
    code`  const matches = (registered, id) => ${modelIdMatches()};`,
    code`  for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {`,
    code`    if (!Object.prototype.hasOwnProperty.call(prototype, key)) continue;`,
    code`    for (const id of among) if (prototype[key].some(registered => matches(registered, id))) return id;`,
    code`  }`,
    code`  return undefined;`,
    code`}`,
  ], NEWLINE)),
  // `selectedModel` for the fast check: the same selection with the key read once at load and no function made per call.
  modelOf: localHelper('modelOf', 9, self => join([
    code`const modelIdsKey = Symbol.for(${literalCode(MODEL_CODEC_IDS_KEY)});`,
    code`const modelIdMatches = (registered, id) => ${modelIdMatches()};`,
    code`function ${self}(value, among) {`,
    code`  if (typeof value !== 'object' || value === null) return undefined;`,
    code`  for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {`,
    code`    if (!Object.prototype.hasOwnProperty.call(prototype, modelIdsKey)) continue;`,
    code`    const registered = prototype[modelIdsKey];`,
    code`    for (let x = 0; x < among.length; x++) for (let y = 0; y < registered.length; y++) if (modelIdMatches(registered[y], among[x])) return among[x];`,
    code`  }`,
    code`  return undefined;`,
    code`}`,
  ], NEWLINE)),
  // What the keywords of one value evaluated: keys by name, or all of them; leading items by count, others by
  // index, or all of them.
  newEvaluation: localHelper('newEvaluation', 10, self => code`const ${self} = () => ({ keys: new Set(), allKeys: false, prefix: 0, indexes: new Set(), allItems: false });`),
  mergeEvaluation: localHelper('mergeEvaluation', 11, self => join([
    code`function ${self}(into, from) {`,
    code`  for (const key of from.keys) into.keys.add(key);`,
    code`  for (const index of from.indexes) into.indexes.add(index);`,
    code`  into.allKeys = into.allKeys || from.allKeys;`,
    code`  into.prefix = Math.max(into.prefix, from.prefix);`,
    code`  into.allItems = into.allItems || from.allItems;`,
    code`}`,
  ], NEWLINE)),
  // The fast check runs a function that has no fast check through its full validator, fail-fast, and reads only the
  // verdict. The path and issue lists are module-level and emptied on each call, so a pass allocates nothing, and a call
  // made while another runs (a getter that validates) changes no verdict: only the returned boolean is read.
  leafPasses: localHelper('leafPasses', 12, self => join([
    code`const scratchPath = [];`,
    code`const scratchIssues = [];`,
    code`function ${self}(validate, value) {`,
    code`  scratchPath.length = 0;`,
    code`  scratchIssues.length = 0;`,
    code`  return validate(value, scratchPath, scratchIssues, false);`,
    code`}`,
  ], NEWLINE)),
};

/** True when `key` is program state of the instance whose `instanceFields` is the local `fields`. */
function stateTest(fields: Code, key: Code): Code {
  return code`${fields} !== undefined && !${fields}.includes(${key})`;
}

/**
 * True when `key` is program state, with `fields` read on first use: a local declared with `let`, `undefined` until a
 * key needs it, then the names or `false` for a value without program state. The lookup runs once for the object, also
 * for a plain value. A value whose keys the schema all names never reads them, so a failing check of a model instance
 * does not walk its prototypes.
 */
function lazyStateTest(fields: Code, value: Code, key: Code, instanceFields: Code): Code {
  return code`(${fields} === undefined ? (${fields} = ${instanceFields}(${value}) ?? false) : ${fields}) !== false && !${fields}.includes(${key})`;
}

const TYPE_TESTS: Readonly<Record<IrTypeName, (value: Code) => Code>> = {
  string: value => code`typeof ${value} === 'string'`,
  // JSON has no NaN or infinity; a model value that holds one is not a number.
  number: value => code`(typeof ${value} === 'number' && Number.isFinite(${value}))`,
  integer: value => code`Number.isInteger(${value})`,
  boolean: value => code`typeof ${value} === 'boolean'`,
  null: value => code`${value} === null`,
  object: value => code`${localName('isObject')}(${value})`,
  array: value => code`Array.isArray(${value})`,
};

/** Module-level state the function bodies add to while they are emitted. */
class ModuleState {
  private readonly declarations: Code[] = [];
  /** The name of each declared constant, by what it holds: one constant serves every use of the same value. */
  private readonly constants = new Map<string, Code>();
  private imports: readonly IrValidationImport[] = [];

  public importValidations(imports: readonly IrValidationImport[]): void {
    this.imports = imports;
  }

  /** The local name of the validation function at `index` of the module's imports. */
  public validationFunction(index: number): Code {
    return identifierCode(`v${index}`);
  }

  /**
   * Declares a module-level constant and returns its name. A constant that holds the same value, as `key` says, is
   * declared once. Every initializer is a call or a `new`, so it carries the annotation that lets a bundler drop the
   * constant with the validator that alone uses it; a call among its arguments carries the annotation too, as a bundler
   * keeps a pure call whose arguments may have side effects. An expression that holds a runtime part has no text to
   * compare, so every constant comes with its `key`.
   */
  public constant(prefix: string, expression: Code, key: string): Code {
    const identity = `${prefix}\u0000${key}`;
    const known = this.constants.get(identity);
    if (known !== undefined) return known;
    const name = identifierCode(`${prefix}${this.declarations.length}`);
    this.declarations.push(code`const ${name} = /*#__PURE__*/ ${expression};`);
    this.constants.set(identity, name);
    return name;
  }

  /** The import line of each validation function the module calls. */
  public validationImports(): readonly Code[] {
    return this.imports.map((entry, index) => {
      const exported = /^[A-Za-z_$][\w$]*$/.test(entry.exportName) ? identifierCode(entry.exportName) : literalCode(entry.exportName);
      return code`import { ${exported} as ${this.validationFunction(index)} } from ${literalCode(entry.importPath)};`;
    });
  }

  /** The declaration of each module-level constant. */
  public constantDeclarations(): readonly Code[] {
    return this.declarations;
  }
}

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
type Capture = readonly [key: string, local: Code];

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
type Lazy = Code | (() => Code);

function resolve(value: Lazy): Code {
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
interface KeyTest {
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
   * would without this object. It reads every value first (spec 7.3), and the passes over the key list read each value
   * before they skip a key.
   */
  readonly failure?: Code;
}

/** Which own values of an object the full validator reads before its checks (spec 7.3). */
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
 * The full validator's read set of an object check (spec 7.3), the one rule for the full validator, the fast key test
 * and the merged union pass. `marks`: the function keeps an evaluation record, so a check that accepts anything still
 * marks its key.
 */
function readSet(check: IrObject, marks: boolean): ReadSet {
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
 * asks for. `presence` gives the reader for the object `value`.
 */
interface WriterMode {
  readonly fail: FailMode;
  /** `captured` names a local for each declared key the object's checks read; a key outside it is read on its own. */
  readonly presence: (state: ModuleState, value: Code, captured?: readonly Capture[]) => PresenceReader;
  /** The form the mode writes of a check that has a full form and may have a cheaper fast one. */
  readonly form: <Form extends Lazy>(full: Form, fast: Form | undefined) => Form;
  /** Writes the key test of an object: it reads the declared keys, and in the fast check also tests the unknown keys and counts the keys. */
  readonly keyTest: (writer: FunctionWriter, request: KeyTestRequest) => KeyTest;
  /** An expression that is true when the function `id` passes `args.value`. */
  readonly call: (writer: FunctionWriter, id: number, args: CallArguments) => Code;
  /** Writes `body`, which checks the child `token` of the current value. */
  readonly child: (writer: FunctionWriter, token: Code, body: () => void) => void;
  /** An expression that selects the model class of `value` among the codec ids `among`. */
  readonly selectModel: (state: ModuleState, value: Code, among: readonly string[]) => Code;
  /** The mode writes functions that keep or receive an evaluation record. */
  readonly records: boolean;
  /**
   * True for a function whose checks a tagged union may write in place of calling it (see `mergedBranches`); absent
   * when the mode always calls each branch.
   */
  readonly mergesBranch?: (id: number) => boolean;
}

const REPORT_FAILURE = code`ok = false; if (!${ALL}) { ${PATH}.length = pl; return false; }`;

function objectPresence(_state: ModuleState, value: Code, captured: readonly Capture[] = []): PresenceReader {
  // One Object.keys pass reads the declared keys of an object; the faster exact form of the JSON view.
  const locals = new Map(captured);
  return {
    setup: captured.length > 0 ? [presentKeysCode(value, captured)] : [],
    present: key => { const local = locals.get(key); return local !== undefined ? code`(${local} !== undefined)` : code`${localName('isPresent')}(${value}, ${literalCode(key)})`; },
    read: key => locals.get(key) ?? code`${value}[${literalCode(key)}]`,
  };
}

/** The full validator: a failed check pushes its issue, then returns at once unless all errors are wanted; a key is read through `isPresent`. */
const FULL_VALIDATOR: WriterMode = {
  fail: {
    start: [code`const pl = ${PATH}.length;`, code`let ok = true;`],
    end: code`return ok;`,
    issue: (fields, path) => [code`${ISSUES}.push({ path: ${path}, ${fields} });`, REPORT_FAILURE],
    fail: () => REPORT_FAILURE,
    leaves: false,
  },
  presence: objectPresence,
  form: full => full,
  // Reads the declared keys; the checks after it loop over the key list for unknown keys and patterns.
  keyTest: (writer, { check, value, captured, reads }) => {
    const presence = objectPresence(writer.state, value, captured);
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
  selectModel: (_state, value, among) => code`${localName('selectedModel')}(${value}, ${literalCode(among)})`,
  records: true,
};

/** `selectedModel` without a function made per call, and its list of codec ids made once. */
function modelOfSelection(state: ModuleState, value: Code, among: readonly string[]): Code {
  return code`${localName('modelOf')}(${value}, ${state.constant('models', code`Object.freeze(${literalCode(among)})`, JSON.stringify(among))})`;
}

/**
 * The full validator of a module with fast checks: it selects a model class as the fast check does, so the module has
 * one selection helper (F-129, F-164). Without fast checks the full validator is `FULL_VALIDATOR`, unchanged.
 */
const FULL_VALIDATOR_BESIDE_FAST_CHECKS: WriterMode = { ...FULL_VALIDATOR, selectModel: modelOfSelection };

/**
 * The key test of the fast check (spec 5.2, F1). An object whose full validator reads only its declared keys reads
 * them as the full validator does. Any other reads every own value in one `Object.keys` pass, as `definedKeys` does,
 * with no exit inside the pass (spec 7.3: a caller such as `not` or a union can turn a `false` into `true`, and then the
 * reads must be the full validator's): a declared key in its own case by its name, every other key in `default`. A key
 * that `additionalProperties: false` forbids is only marked, and a schema of `additionalProperties` runs after
 * `required` in a second pass, both in the full validator's order. A key that matches a pattern of `patternProperties` is
 * not additional. A keyword that loops over the keys (a schema of `additionalProperties`, `patternProperties`,
 * `propertyNames`) gets the one key list, which also holds the keys whose value is `undefined`. The pass is written only
 * when it has a case, a count, an unknown key or a captured key to handle. Otherwise it would only read the values: the
 * passes over the key list read them, and a failure of theirs reads the rest before it leaves (`KeyTest.failure`).
 */
function fastKeyTest(writer: FunctionWriter, { check, value, captured, reads }: KeyTestRequest): KeyTest {
  const presence = objectPresence(writer.state, value, captured);
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
 * The fast check `is_X(v)` (spec 5.1): true exactly when the full validator reports no issue. A failed check returns
 * `false`; no path and no issue is built. A function with a fast check is called as `isN(v)`; any other through its full
 * validator (`leafPasses`).
 */
function fastCheckMode(plan: FastPlan): WriterMode {
  const leafCall = (writer: FunctionWriter, id: number, value: Code): Code => {
    writer.calls.add(id);
    return code`${localName('leafPasses')}(${nameOf(writer.calleeSlot(id, false))}, ${value})`;
  };
  return {
    fail: { start: [], end: code`return true;`, issue: () => [code`return false;`], fail: () => code`return false;`, leaves: true },
    presence: objectPresence,
    form: (full, fast) => fast ?? full,
    keyTest: fastKeyTest,
    call: (writer, id, args) => {
      const target = writer.target(id);
      if (!plan.has(target)) return leafCall(writer, target, args.value);
      writer.fastCalls.add(target);
      return code`${nameOf(writer.calleeSlot(target, true))}(${args.value})`;
    },
    child: (_writer, _token, body) => body(),
    selectModel: modelOfSelection,
    records: false,
    // A branch with a fast check is exact on its own, so its checks are exact in place too.
    mergesBranch: id => plan.has(id),
  };
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

/** The module constant that holds the regular expression of `pattern`; it has no `g` flag, so a test leaves no `lastIndex`. */
function patternExpression(state: ModuleState, pattern: string): Code {
  return state.constant('pattern', code`new RegExp(${literalCode(pattern)}, 'u')`, pattern);
}

/** Writes one function in the given mode: the mode decides what a failed check writes and how a declared key is read. */
class FunctionWriter {
  private readonly lines: Code[] = [];
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
    this.lines.push(code`}`);
    return join(this.lines, NEWLINE);
  }

  public line(statement: Code): void {
    this.lines.push(indented(this.depth * 2, statement));
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

  private leaf(check: LeafCheck): void {
    const failing = resolve(this.mode.form(check.fails, check.fast));
    if (this.mode.fail.leaves) return this.failWhen(failing);
    this.open(code`if (${failing})`);
    this.issue(resolve(check.issue), check.path);
    this.close();
  }

  /** The `tooSmall` and `tooBig` leaves of a lower and an upper limit on `measure`, whose value `actual` holds; `fast` writes each test cheaper. */
  private limitLeaves(measure: string, actual: Lazy, min: number | undefined, max: number | undefined, fast?: { readonly min: (limit: number) => Code; readonly max: (limit: number) => Code }): void {
    if (min !== undefined) this.leaf({ fails: () => code`${resolve(actual)} < ${literalCode(min)}`, ...(fast ? { fast: () => fast.min(min) } : {}), issue: limitFields('tooSmall', measure, min, true) });
    if (max !== undefined) this.leaf({ fails: () => code`${resolve(actual)} > ${literalCode(max)}`, ...(fast ? { fast: () => fast.max(max) } : {}), issue: limitFields('tooBig', measure, max, true) });
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
        return this.leaf({ fails: code`!(${join(check.names.map(name => TYPE_TESTS[name](value)), code` || `)})`, issue: code`code: 'type', expected: ${literalCode(check.names)}` });
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
        });
      case 'date':
        return this.leaf({ fails: code`!(${value} instanceof Date) || !Number.isFinite(${value}.getTime())`, issue: code`code: 'type', expected: ['Date']` });
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
        return this.leaf({ fails: this.call(check.fn, { value, issues: code`[]`, all: code`false` }), issue: code`code: 'not'` });
      case 'conditional': return this.conditionalCheck(check, value);
      case 'dependentSchemas': {
        const presence = this.mode.presence(this.state, value);
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

  /** The class the value's encoder selects must be `of`; see `IrInstance`. */
  private instanceCheck(check: IrInstance, value: Code): void {
    const selected = this.fresh('selected');
    this.line(code`const ${selected} = ${this.mode.selectModel(this.state, value, check.among)};`);
    const expected = check.of === undefined ? code`undefined` : literalCode(check.of);
    this.leaf({
      fails: check.required || check.of === undefined ? code`${selected} !== ${expected}` : code`${selected} !== undefined && ${selected} !== ${expected}`,
      issue: code`code: 'instance', model: ${literalCode(check.of ?? check.among[0])}`,
    });
  }

  /** The functions run only after the structural schema passed, so they never see a value of the wrong shape. */
  private validationCheck(check: IrValidation, value: Code): void {
    // A function that reaches a validation function has no fast check (spec 5.1 rule 7): the predicate runs once.
    if (!this.mode.records) throw new Error(`The validator compiler writes no fast check for the schema function ${this.fn.id}: it reaches a validation function.`);
    const runCalls = (): void => {
      for (const index of check.calls) {
        const result = this.fresh('result');
        this.line(code`const ${result} = ${this.state.validationFunction(index)}(${value});`);
        this.open(code`if (typeof ${result} !== 'boolean' && typeof ${result} !== 'string')`);
        this.line(code`throw new TypeError("Validation functions must return boolean or string.");`);
        this.close();
        this.leaf({ fails: code`${result} !== true`, issue: code`code: 'custom', ...(typeof ${result} === 'string' && ${result}.length > 0 ? { reason: ${result} } : {})` });
      }
    };
    if (check.fn === undefined) return runCalls();
    this.open(code`if (${this.call(check.fn, { value, issues: ISSUES, all: ALL, ...(this.record === undefined ? {} : { record: this.record }) })})`);
    runCalls();
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
    this.limitLeaves('length', length, check.minLength, check.maxLength, {
      min: limit => code`${value}.length < ${literalCode(2 * limit)} && ${codePoints()} < ${literalCode(limit)}`,
      max: limit => code`${value}.length > ${literalCode(limit)} && ${codePoints()} > ${literalCode(limit)}`,
    });
    if (check.pattern !== undefined) {
      const expression = patternExpression(this.state, check.pattern);
      this.leaf({ fails: code`!${expression}.test(${value})`, issue: code`code: 'pattern', pattern: ${literalCode(check.pattern)}` });
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
      this.leaf({ fails: code`${value} ${operator} ${literalCode(limit)}`, issue: limitFields(kind, 'value', limit, inclusive) });
    }
    if (check.multipleOf !== undefined) this.leaf({ fails: code`!${localName('isMultipleOf')}(${value}, ${literalCode(check.multipleOf)})`, issue: code`code: 'multipleOf', divisor: ${literalCode(check.multipleOf)}` });
  }

  private arrayCheck(check: IrArray, value: Code, types: readonly IrTypeName[] | undefined): void {
    this.guarded(code`if (Array.isArray(${value}))`, ['array'], types, () => {
      this.limitLeaves('items', code`${value}.length`, check.minItems, check.maxItems);
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
      if (check.uniqueItems) {
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
      }
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

  /** Counts the items that pass `contains`; the count must lie between its limits, and each match counts as evaluated. */
  private containsCheck(contains: NonNullable<IrArray['contains']>, value: Code): void {
    const marks = this.record !== undefined;
    if (contains.min === 0 && contains.max === undefined && !marks) return;
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
    this.limitLeaves('matches', count, contains.min > 0 ? contains.min : undefined, contains.max);
  }

  private objectCheck(check: IrObject, value: Code, types: readonly IrTypeName[] | undefined): void {
    this.guarded(code`if (${TYPE_TESTS.object(value)})`, ['object'], types, () => this.objectKeywords(check, value), true);
  }

  /** The type check that requires an object, and the object keywords in its `else`: the value is tested once. */
  private objectOrTypeIssue(type: IrType, check: IrObject, value: Code): void {
    // A mode that leaves at a failure needs no `else`: the keywords follow the type test.
    if (this.mode.fail.leaves) {
      this.failWhen(code`!${TYPE_TESTS.object(value)}`);
      return this.objectKeywords(check, value);
    }
    this.open(code`if (!${TYPE_TESTS.object(value)})`);
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
    const { visitsAdditional } = reads;
    const captured = reads.declared.map(key => [key, this.fresh('present')] as const);
    // A key that matches a pattern is not "additional" even when the pattern's schema accepts everything.
    const patterns = check.patternProperties.map(entry => ({ entry, expression: patternExpression(this.state, entry.pattern) }));
    const patternsToRun = patterns.filter(({ entry }) => reads.patterns.includes(entry));
    const { presence, count, keys, undefinedToo, unknown, failure } = prepared ?? this.mode.keyTest(this, { check, value, captured, reads });
    // The key test makes the key list or the count for each check below that reads it.
    const listed = (what: Code | undefined): Code => {
      if (what === undefined) throw new Error('The key test of this validator mode left no key list or count for an object check that reads it.');
      return what;
    };
    this.limitLeaves('properties', () => listed(count), check.minProperties, check.maxProperties);
    const required = (key: string): LeafCheck => ({ fails: code`!${presence.present(key)}`, issue: code`code: 'required', key: ${literalCode(key)}`, path: code`[...${PATH}, ${literalCode(key)}]` });
    for (const key of check.required) this.leaf(required(key));
    for (const { trigger, keys: dependents } of check.dependentRequired) {
      if (dependents.length === 0) continue;
      this.open(code`if (${presence.present(trigger)})`);
      for (const key of dependents) this.leaf(required(key));
      this.close();
    }
    // Ahead of `properties`: with fail-fast the first issue is the object's own unknown key. A key test that made `unknown` ran it.
    if (unknown !== undefined) this.failWhen(unknown);
    // The passes below fail only after the values are read, which the key test left to them.
    const outer = this.mode;
    // A failure of the passes reads this object's values, then fails as the enclosing object does, which reads its own.
    if (failure !== undefined) {
      const chained = code`{ ${failure} ${outer.fail.fail()} }`;
      this.mode = { ...outer, fail: { ...outer.fail, issue: () => [chained], fail: () => chained } };
    }
    if (check.additional && visitsAdditional && keys !== undefined && unknown === undefined) {
      const additional = check.additional;
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
    if (patternsToRun.length > 0) {
      const fields = this.fresh('fields');
      this.line(code`let ${fields};`);
      const key = this.fresh('key');
      this.open(code`for (const ${key} of ${listed(keys)})`);
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
    // `additionalProperties` takes every key the other two did not.
    if (check.additional !== undefined) this.mark(record => code`${record}.allKeys = true;`);
    if (check.propertyNames !== undefined) {
      const key = this.fresh('key');
      this.open(code`for (const ${key} of ${listed(keys)})`);
      if (undefinedToo) this.line(code`if (${value}[${key}] === undefined) continue;`);
      // A name that the instance's own model does not declare is program state, not a property name to judge.
      this.leaf({ fails: code`!${this.call(check.propertyNames, { value: key, issues: code`[]`, all: code`false` })} && !${localName('isInstanceState')}(${value}, ${key})`, issue: code`code: 'invalidKey', key: ${key}` });
      this.close();
    }
    this.mode = outer;
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

  /** `if` runs with a scratch list and, when this function keeps a record, a scratch record that counts only when `if` passes. */
  private conditionalCheck(check: Extract<IrCheck, { kind: 'conditional' }>, value: Code): void {
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

  private unionCheck(check: IrUnion, value: Code): void {
    if (this.record !== undefined) return this.recordingUnionCheck(check, value);
    const attempt = (fn: number): Code => this.call(fn, { value, issues: code`[]`, all: code`false` });
    if (!check.exactlyOne) return this.leaf({ fails: code`!(${join(check.branches.map(attempt), code` || `)})`, issue: code`code: 'union', matched: 0` });
    const matched = this.fresh('matched');
    this.line(code`let ${matched} = 0;`);
    // Two matches already decide the outcome, so later branches are not run.
    check.branches.forEach((fn, position) => this.line(code`if (${position === 0 ? code`` : code`${matched} < 2 && `}${attempt(fn)}) ${matched}++;`));
    this.leaf({ fails: code`${matched} !== 1`, issue: code`code: 'union', matched: ${matched}` });
  }

  /** Every branch that passes marks what it evaluated, so `anyOf` runs all of its branches here. */
  private recordingUnionCheck(check: IrUnion, value: Code): void {
    const record = this.requireRecord();
    const matched = this.fresh('matched');
    this.line(code`let ${matched} = 0;`);
    check.branches.forEach((fn, position) => {
      const scratch = this.fresh('scratch');
      this.open(position === 0 || !check.exactlyOne ? undefined : code`if (${matched} < 2)`);
      this.line(code`const ${scratch} = ${localName('newEvaluation')}();`);
      this.open(code`if (${this.call(fn, { value, issues: code`[]`, all: code`false`, record: scratch })})`);
      this.line(code`${matched}++;`);
      this.line(code`${localName('mergeEvaluation')}(${record}, ${scratch});`);
      this.close();
      this.close();
    });
    this.leaf({ fails: check.exactlyOne ? code`${matched} !== 1` : code`${matched} === 0`, issue: code`code: 'union', matched: ${matched}` });
  }

  /**
   * The tag selects the branch; only that branch's issues are reported, and an unknown tag is a `literal` issue on the
   * tag property. The tag is read once; the first branch whose list holds it is selected, as a tag lies in one list.
   */
  private discriminatedUnion(check: IrUnion, discriminator: IrDiscriminator, value: Code): void {
    const merged = this.mergedBranches(check);
    if (merged !== undefined) {
      const targets = check.branches.map(id => this.target(id));
      for (const target of targets) this.merging.add(target);
      this.mergedUnion(merged, discriminator, value);
      for (const target of targets) this.merging.delete(target);
      return;
    }
    const presence = this.mode.presence(this.state, value);
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
   * up front, and runs its checks in the full branch's order (spec 7.3). A closed branch also requires each key it does
   * not name to be absent. Every read is of an own enumerable key (spec 5.1 rule 3).
   */
  private mergedUnion(branches: readonly IrObject[], discriminator: IrDiscriminator, value: Code): void {
    this.failWhen(code`!${TYPE_TESTS.object(value)}`);
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
      this.objectKeywords(object, value, { presence: objectPresence(this.state, value, captured) });
      this.close();
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
 * True when a check of a fast check decides something itself, not one that only passes the value to other functions:
 * `allOf` through its branches, a union, `not`, `$ref`, `if` and `dependentSchemas` through the functions they call,
 * which must have a fast check of their own (spec 5.4 a). A validation function and `unevaluated*` have no fast form;
 * a function that holds one is never planned (`FastPlan`).
 */
function decidesFast(check: IrCheck, has: (id: number) => boolean): boolean {
  switch (check.kind) {
    case 'allOf': return check.branches.some(branch => branch.kind === 'never' || (branch.kind === 'checks' && branch.checks.some(inner => decidesFast(inner, has))));
    case 'union': return check.branches.some(has);
    case 'not': case 'call': return has(check.fn);
    case 'conditional': return [check.if, check.then, check.else].some(id => id !== undefined && has(id));
    case 'dependentSchemas': return check.entries.some(entry => has(entry.fn));
    case 'validation': case 'unevaluatedProperties': case 'unevaluatedItems': return false;
    case 'type': case 'literal': case 'format': case 'date': case 'string': case 'number': case 'instance': case 'array': case 'object':
      return true;
  }
}

/** True when a fast check of `fn` pays: a check of it decides something itself, so a failing value is not run twice for nothing (spec 5.4 a). */
function fastBody(fn: IrFunction, has: (id: number) => boolean): boolean {
  return fn.body.kind !== 'checks' || fn.body.checks.some(check => decidesFast(check, has));
}

/**
 * Which functions get a fast check. A function gets one when it keeps and receives no evaluation record (spec 5.4, the
 * record travels through full validators), its IR call graph reaches no validation function, so each predicate runs once
 * per conversion (rule 7), and its body pays (`fastBody`), counting a call only to a function that has a fast check itself.
 */
class FastPlan {
  private readonly fast = new Set<number>();

  public constructor(functions: readonly IrFunction[]) {
    const reaching = reachingValidation(functions);
    const candidates = functions.filter(fn => !fn.collects && !fn.receives && !reaching.has(fn.id));
    const has = (id: number): boolean => this.fast.has(id);
    for (let grew = true; grew;) {
      grew = false;
      for (const fn of candidates) {
        if (this.fast.has(fn.id) || !fastBody(fn, has)) continue;
        this.fast.add(fn.id);
        grew = true;
      }
    }
  }

  public has(id: number): boolean {
    return this.fast.has(id);
  }
}

/** The fast check of a function as text, with what it calls. */
interface WrittenFastCheck {
  /** The body; the full validators and fast checks it calls are name parts. */
  readonly body: Code;
  readonly calls: ReadonlySet<number>;
  readonly fastCalls: ReadonlySet<number>;
}

interface WrittenFunction {
  readonly id: number;
  readonly parameters: Code;
  /** The body; the functions it calls are name parts. */
  readonly body: Code;
  readonly calls: ReadonlySet<number>;
  /** The fast check, for a function that has one. */
  readonly fast?: WrittenFastCheck;
}

function writeFunction(state: ModuleState, module: IrModule, target: (id: number) => number, calleeSlot: CalleeSlot, fn: IrFunction, mode: WriterMode): WrittenFunction {
  const writer = new FunctionWriter(state, module.functions, target, fn, mode, calleeSlot);
  const body = writer.write();
  return { id: fn.id, parameters: functionParameters(fn), body, calls: writer.calls };
}

function writeFastCheck(state: ModuleState, module: IrModule, target: (id: number) => number, calleeSlot: CalleeSlot, fn: IrFunction, mode: WriterMode): WrittenFastCheck {
  const writer = new FunctionWriter(state, module.functions, target, fn, mode, calleeSlot);
  return { body: writer.write(), calls: writer.calls, fastCalls: writer.fastCalls };
}

/** The function a name part calls, and whether it calls the fast check. */
type Callee = { readonly id: number; readonly fast: boolean };

/**
 * The key of a body: its parts, and for each name part the group of the function it calls (and whether it is the fast
 * check). Two bodies with one key are the same code once each call names the group of its callee. The key of the parts
 * that name no callee is made once (`BodyKey`); each round of `groupFunctions` joins it to the groups of the callees.
 */
interface BodyKey {
  /** The key between two callees, and after the last. */
  readonly pieces: readonly string[];
  /** The callees in order of appearance: `pieces` has one more entry than `callees`. */
  readonly callees: readonly Callee[];
}

function bodyKeyOf(body: Code, slots: FunctionSlots): BodyKey {
  const pieces: string[] = [];
  const callees: Callee[] = [];
  let key = '';
  let text = '';
  for (const part of body.parts) {
    if (part.kind === 'text') {
      // Where the text was split into parts names nothing: adjacent text is one text.
      text += part.text;
      continue;
    }
    if (text !== '') { key += `${JSON.stringify(text)},`; text = ''; }
    switch (part.kind) {
      case 'name': {
        const callee = slots.owner(part.slot);
        if (callee === undefined) throw new Error(`The validator compiler body names "${part.slot.label}", which is no function.`);
        pieces.push(key);
        key = '';
        callees.push(callee);
        break;
      }
      case 'runtime': key += `r${JSON.stringify([part.module, part.name, part.typeOnly === true, part.alias ?? null])},`; break;
      case 'imported': key += `i${JSON.stringify([part.source.specifier, part.name, part.typeOnly === true, part.alias ?? null])},`; break;
      case 'helper': key += `h${JSON.stringify(part.helper.id)},`; break;
      case 'export': key += `e${JSON.stringify(part.name)},`; break;
      case 'input': key += `p${inputNumber(part.slot)},`; break;
      case 'line': key += 'l,'; break;
      case 'indent': key += `d${part.by},`; break;
      default: return unreachablePart(part);
    }
  }
  pieces.push(text === '' ? key : key + JSON.stringify(text));
  return { pieces, callees };
}

function bodyKey({ pieces, callees }: BodyKey, groups: ReadonlyMap<number, number>): string {
  let key = pieces[0]!;
  for (let index = 0; index < callees.length; index += 1) {
    const callee = callees[index]!;
    key += `n${callee.fast},${groups.get(callee.id) ?? -1},${pieces[index + 1]!}`;
  }
  return key;
}

function unreachablePart(part: never): never {
  throw new Error(`Internal error: the validator compiler body holds an unknown part ${JSON.stringify(part)}`);
}

const inputNumbers = new WeakMap<InputSlot, number>();
let inputsNumbered = 0;

/** A number for an input slot that is the same each time, so bodies that read the same slot have the same key. */
function inputNumber(slot: InputSlot): number {
  const known = inputNumbers.get(slot);
  if (known !== undefined) return known;
  inputNumbers.set(slot, inputsNumbered);
  return inputsNumbered++;
}

/**
 * Groups the functions that behave alike: those with the same parameters whose bodies are the same code once each call
 * names the group of its callee. Groups start as one and split until stable, so recursive functions that mirror each
 * other (a model and its wire form) end up together. The fast check is no part of the key: it follows from the body, and
 * a model root and an operation root of the same schema must share one function whether or not the fast check is
 * written for both. A group is named by its lowest id that `fastReached` holds, else by its lowest id, so the group's
 * fast check is written from a function that has one.
 */
function groupFunctions(written: readonly WrittenFunction[], fastReached: ReadonlySet<number>, slots: FunctionSlots): ReadonlyMap<number, number> {
  // The key of a body and the text of its parameters do not change between rounds; only the groups of the callees do.
  const keyed = new Map(written.map(entry => [entry.id, bodyKeyOf(entry.body, slots)]));
  const parameters = new Map(written.map(entry => [entry.id, render(entry.parameters)]));
  let groups = new Map<number, number>(written.map(entry => [entry.id, 0]));
  let size = 1;
  for (;;) {
    const keys = new Map<string, number>();
    const next = new Map<number, number>();
    for (const entry of written) {
      const key = `${groups.get(entry.id)}\n${parameters.get(entry.id)}\n${bodyKey(keyed.get(entry.id)!, groups)}`;
      if (!keys.has(key)) keys.set(key, keys.size);
      next.set(entry.id, keys.get(key) ?? 0);
    }
    if (keys.size === size) break;
    groups = next;
    size = keys.size;
  }
  const lowest = new Map<number, number>();
  for (const entry of [...written].sort((first, second) => Number(fastReached.has(second.id)) - Number(fastReached.has(first.id)) || first.id - second.id)) {
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
  // A set of root names is any `ReadonlySet`, not only a `Set`.
  const plan = fastPath === true || (typeof fastPath === 'object' && fastPath.size > 0) ? new FastPlan(module.functions) : undefined;
  const wantsFastCheck = (name: string): boolean => fastPath === true || (typeof fastPath === 'object' && fastPath.has(name));
  const fastMode = plan === undefined ? undefined : fastCheckMode(plan);
  const fullMode = plan === undefined ? FULL_VALIDATOR : FULL_VALIDATOR_BESIDE_FAST_CHECKS;
  const hasFastCheck = (id: number): boolean => plan?.has(id) ?? false;
  // First pass: every function as code, to learn which of those the roots reach are the same.
  const survey = new ModuleState();
  survey.importValidations(module.validations);
  const slots = new FunctionSlots(module.functions);
  const ownSlot: CalleeSlot = (id, fast) => slots.of(id, fast);
  const written = new Map(module.functions.filter(fn => target(fn.id) === fn.id).map(fn => [fn.id, {
    ...writeFunction(survey, module, target, ownSlot, fn, fullMode),
    ...(fastMode !== undefined && hasFastCheck(fn.id) ? { fast: writeFastCheck(survey, module, target, ownSlot, fn, fastMode) } : {}),
  }] as const));
  const fastRootExports = module.exports.filter(({ name, fn }) => wantsFastCheck(name) && hasFastCheck(target(fn)));
  const fastRoots = fastRootExports.map(({ fn }) => target(fn));
  const fastReached = reachable(fastRoots, id => written.get(id)?.fast?.fastCalls ?? []);
  const reached = reachable(
    [...module.exports.map(({ fn }) => target(fn)), ...[...fastReached].flatMap(id => [...(written.get(id)?.fast?.calls ?? [])])],
    id => written.get(id)?.calls ?? [],
  );
  const representative = groupFunctions([...written.values()].filter(entry => reached.has(entry.id)), fastReached, slots);
  const kept = [...new Set(representative.values())].sort((first, second) => first - second);
  const fastKept = new Set([...fastReached].map(id => representative.get(id) ?? id));
  // A name has one slot: the slot of the function that stays, which every call of the functions grouped with it names.
  const stayingSlot: CalleeSlot = (id, fast) => {
    const staying = representative.get(id);
    if (staying === undefined) throw new Error(`The validator compiler has no emitted function for the schema function ${id}.`);
    return slots.of(staying, fast);
  };
  const names = new NameTable();
  kept.forEach((id, index) => {
    names.declare(slots.of(id, false), functionName(index, module.functions[id].name, false));
    if (fastKept.has(id)) names.declare(slots.of(id, true), functionName(index, module.functions[id].name, true));
  });
  // Second pass: only the functions that stay, so the constants and helpers are those they use.
  const state = new ModuleState();
  state.importValidations(module.validations);
  const functions = kept.map(id => {
    const { parameters, body } = writeFunction(state, module, target, stayingSlot, module.functions[id], fullMode);
    return code`function ${nameOf(slots.of(id, false))}(${parameters}) {\n${body}`;
  });
  const fastFunctions = fastMode === undefined ? [] : [...fastKept].sort((first, second) => first - second)
    .map(id => code`function ${nameOf(slots.of(id, true))}(${VALUE}) {\n${writeFastCheck(state, module, target, stayingSlot, module.functions[id], fastMode).body}`);
  const exported = exportNames(module.exports.map(({ name }) => name));
  const exportName = (name: string): string => {
    const known = exported.get(name);
    if (known === undefined) throw new Error(`The validator compiler has no export name for the root ${JSON.stringify(name)}.`);
    return known;
  };
  const signature = options.typed ? code`(value: unknown, all: boolean): readonly ${rtType['validation-runtime'].SchemaIssue}[] {` : code`(value, all) {`;
  const wrappers = module.exports.map(({ name, fn }) => code`export function ${identifierCode(exportName(name))}${signature}
  const issues = [];
  ${callFunction(module.functions[target(fn)], nameOf(stayingSlot(target(fn), false)), { value: identifierCode('value'), path: code`[]`, issues: identifierCode('issues'), all: identifierCode('all') })};
  return issues;
}`);
  const fastExports = new Map(fastRootExports.map(({ name }) => [name, fastExportName(exportName(name))] as const));
  // The fast check itself is the export: a valid value takes no extra call.
  const fastType = options.typed ? code`: (value: unknown) => boolean` : code``;
  const fastWrappers = fastRootExports.map(({ name, fn }) => code`export const ${identifierCode(fastExportName(exportName(name)))}${fastType} = ${nameOf(stayingSlot(target(fn), true))};`);
  // The imports and the helpers come from the parts of everything the file holds.
  const contents = [...state.constantDeclarations(), ...functions, ...fastFunctions, ...wrappers, ...fastWrappers];
  const everything = join(contents, NEWLINE);
  return {
    source: render(join([
      ...runtimeImports(everything, { specifiers: { 'validation-runtime': options.runtimeModule }, quote: '"' }),
      ...state.validationImports(),
      ...helperDefinitions(everything),
      ...contents,
      code``,
    ], NEWLINE), names),
    fastExports,
  };
}
