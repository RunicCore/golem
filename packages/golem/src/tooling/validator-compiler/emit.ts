import { code, helperDefinitions, identifier as identifierCode, join, nameOf, NameTable, render, runtimeImports, type Code } from '../code.js';
import type { IrFunction, IrModule } from './ir.js';
import { compareText } from '../generator-api.js';
import { rtType } from '../rt.js';
import { VALUE, NEWLINE, functionParameters, FunctionSlots, callFunction, type CalleeSlot } from './function-names.js';
import { FULL_VALIDATOR, fastCheckMode, type WriterMode } from './modes.js';
import { ModuleState } from './module-state.js';
import { FunctionWriter } from './function-writer.js';
import { forwardingTarget, reachable } from './call-graph.js';
import { FastPlan } from './fast-plan.js';
import { groupFunctions, type WrittenFastCheck, type WrittenFunction } from './grouping.js';

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

function writeFunction(state: ModuleState, module: IrModule, target: (id: number) => number, calleeSlot: CalleeSlot, fn: IrFunction, mode: WriterMode): WrittenFunction {
  const writer = new FunctionWriter(state, module.functions, target, fn, mode, calleeSlot);
  const body = writer.write();
  return { id: fn.id, parameters: functionParameters(fn), body, calls: writer.calls };
}

function writeFastCheck(state: ModuleState, module: IrModule, target: (id: number) => number, calleeSlot: CalleeSlot, fn: IrFunction, mode: WriterMode): WrittenFastCheck {
  const writer = new FunctionWriter(state, module.functions, target, fn, mode, calleeSlot);
  return { body: writer.write(), calls: writer.calls, fastCalls: writer.fastCalls };
}

/** What every step of `emit` reads: the module, how its functions forward, and which fast checks are planned. */
interface Emission {
  readonly module: IrModule;
  readonly target: (id: number) => number;
  readonly plan: FastPlan | undefined;
  readonly fastMode: WriterMode | undefined;
  readonly slots: FunctionSlots;
  /** The roots that export a fast check. */
  readonly fastRootExports: IrModule['exports'];
}

/** The functions the roots reach, grouped: the function that stays for each group, and the fast checks written. */
interface Reached {
  readonly fastReached: ReadonlySet<number>;
  readonly representative: ReadonlyMap<number, number>;
  readonly kept: readonly number[];
  readonly fastKept: ReadonlySet<number>;
}

function startEmission(module: IrModule, fastPath: EmitOptions['fastPath']): Emission {
  const target = forwardingTarget(module.functions);
  // A set of root names is any `ReadonlySet`, not only a `Set`.
  const plan = fastPath === true || (typeof fastPath === 'object' && fastPath.size > 0) ? new FastPlan(module.functions) : undefined;
  const wantsFastCheck = (name: string): boolean => fastPath === true || (typeof fastPath === 'object' && fastPath.has(name));
  return {
    module,
    target,
    plan,
    fastMode: plan === undefined ? undefined : fastCheckMode(plan),
    slots: new FunctionSlots(module.functions),
    fastRootExports: module.exports.filter(({ name, fn }) => wantsFastCheck(name) && (plan?.has(target(fn)) ?? false)),
  };
}

/** First pass: every function as code, to learn which of those the roots reach are the same. */
function surveyFunctions({ module, target, plan, fastMode, slots }: Emission): ReadonlyMap<number, WrittenFunction> {
  const survey = new ModuleState();
  survey.importValidations(module.validations);
  const ownSlot: CalleeSlot = (id, fast) => slots.of(id, fast);
  return new Map(module.functions.filter(fn => target(fn.id) === fn.id).map(fn => [fn.id, {
    ...writeFunction(survey, module, target, ownSlot, fn, FULL_VALIDATOR),
    ...(fastMode !== undefined && (plan?.has(fn.id) ?? false) ? { fast: writeFastCheck(survey, module, target, ownSlot, fn, fastMode) } : {}),
  }] as const));
}

function reachedFunctions({ module, target, slots, fastRootExports }: Emission, written: ReadonlyMap<number, WrittenFunction>): Reached {
  const fastReached = reachable(fastRootExports.map(({ fn }) => target(fn)), id => written.get(id)?.fast?.fastCalls ?? []);
  const reached = reachable(
    [...module.exports.map(({ fn }) => target(fn)), ...[...fastReached].flatMap(id => [...(written.get(id)?.fast?.calls ?? [])])],
    id => written.get(id)?.calls ?? [],
  );
  const representative = groupFunctions([...written.values()].filter(entry => reached.has(entry.id)), fastReached, slots);
  return {
    fastReached,
    representative,
    kept: [...new Set(representative.values())].sort((first, second) => first - second),
    fastKept: new Set([...fastReached].map(id => representative.get(id) ?? id)),
  };
}

/** The names of the functions that stay, and of their fast checks. */
function declareFunctionNames({ module, slots }: Emission, { kept, fastKept }: Reached): NameTable {
  const names = new NameTable();
  kept.forEach((id, index) => {
    names.declare(slots.of(id, false), functionName(index, module.functions[id].name, false));
    if (fastKept.has(id)) names.declare(slots.of(id, true), functionName(index, module.functions[id].name, true));
  });
  return names;
}

/** The slot of the function that stays, which every call of the functions grouped with it names: a name has one slot. */
function stayingSlotOf({ slots }: Emission, { representative }: Reached): CalleeSlot {
  return (id, fast) => {
    const staying = representative.get(id);
    if (staying === undefined) throw new Error(`The validator compiler has no emitted function for the schema function ${id}.`);
    return slots.of(staying, fast);
  };
}

/** Second pass: only the functions that stay, so the constants and helpers are those they use. */
function writeStaying({ module, target, fastMode, slots }: Emission, { kept, fastKept }: Reached, stayingSlot: CalleeSlot): { readonly state: ModuleState; readonly functions: readonly Code[]; readonly fastFunctions: readonly Code[] } {
  const state = new ModuleState();
  state.importValidations(module.validations);
  const functions = kept.map(id => {
    const { parameters, body } = writeFunction(state, module, target, stayingSlot, module.functions[id], FULL_VALIDATOR);
    return code`function ${nameOf(slots.of(id, false))}(${parameters}) {\n${body}`;
  });
  const fastFunctions = fastMode === undefined ? [] : [...fastKept].sort((first, second) => first - second)
    .map(id => code`function ${nameOf(slots.of(id, true))}(${VALUE}) {\n${writeFastCheck(state, module, target, stayingSlot, module.functions[id], fastMode).body}`);
  return { state, functions, fastFunctions };
}

/** The exported wrapper of each root, and of each fast check. */
function writeExports({ module, target, fastRootExports }: Emission, stayingSlot: CalleeSlot, options: EmitOptions): { readonly wrappers: readonly Code[]; readonly fastWrappers: readonly Code[]; readonly fastExports: ReadonlyMap<string, string> } {
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
  return { wrappers, fastWrappers, fastExports };
}

/**
 * Emits the module: one function per distinct behavior and one exported wrapper per root, named by `exportNames`.
 * Every check is written once: a forwarding function, and a function the same as another, are not emitted, and
 * their callers call the one that is. With `fastPath`, each root that has a fast check (see `FastPlan`) also exports
 * `is_X`, and only the fast checks those reach are written.
 */
export function emit(module: IrModule, options: EmitOptions): EmitResult {
  const emission = startEmission(module, options.fastPath);
  const reached = reachedFunctions(emission, surveyFunctions(emission));
  const stayingSlot = stayingSlotOf(emission, reached);
  const names = declareFunctionNames(emission, reached);
  const { state, functions, fastFunctions } = writeStaying(emission, reached, stayingSlot);
  const { wrappers, fastWrappers, fastExports } = writeExports(emission, stayingSlot, options);
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
