import { code, helperDefinitions, identifier as identifierCode, join, nameOf, NameTable, render, runtimeImports, type Code, type ImportOptions } from '../code.js';
import type { IrFunction, IrModule } from './ir.js';
import { compareText } from '../generator-core.js';
import { NEWLINE, SANITY, NOTATIONS, functionParameters, valueParameter, FunctionSlots, callFunction, type CalleeSlot, type CheckForm, type Notation } from './function-names.js';
import type { Language } from './options.js';
import { FULL_VALIDATOR, fastCheckMode, type WriterMode } from './modes.js';
import { ModuleState } from './module-state.js';
import { FunctionWriter } from './function-writer.js';
import { forwardingTarget, markSanity, projectPasses, reachable, sanitize } from './call-graph.js';
import { FastPlan } from './fast-plan.js';
import { groupFunctions, type WrittenFastCheck, type WrittenFunction } from './grouping.js';

interface EmitOptions {
  /** The specifiers the generated file imports its runtime helpers and their types from; the internal validation runtime and the public subpath by default. */
  readonly specifiers?: ImportOptions['specifiers'];
  /** The language of the module; `ts` types each header and each exported validator. */
  readonly language: Language;
  /** Also writes the boolean fast check `is_X` beside `validate_X`, for each root (`'all'`) or each root named, that has one (see `FastPlan`). Absent: none. */
  readonly fastPath?: 'all' | ReadonlySet<string>;
  /** `sanity` writes the module that checks the shape only (see `sanitize`); `full`, the default, one module whose validators skip the value limits when the caller passes the flag `s`. */
  readonly level?: 'full' | 'sanity';
}

/** The names a root's two passes are exported under; see `PassRoot`. */
export interface PassExports {
  readonly structure: string;
  readonly predicates: string;
}

interface EmitResult {
  readonly source: string;
  /** The name each root's fast check is exported under, by root name; only roots that have one. */
  readonly fastExports: ReadonlyMap<string, string>;
  /** The names each root's structure check and predicates-only pass are exported under, by root name; only roots that have them. */
  readonly passExports: ReadonlyMap<string, PassExports>;
}

/** The longest part of a schema's name that a function name keeps. */
const NAME_LIMIT = 40;

/** Characters that cannot appear in a name become `_`. */
function identifier(text: string): string {
  return text.replace(/[^A-Za-z0-9_$]/g, '_');
}

/** Every name a root is exported under. */
interface RootExportNames {
  /** The validator. */
  readonly validate: string;
  /** The fast check. */
  readonly fast: string;
  /** The structure check and the predicates-only pass. */
  readonly passes: PassExports;
}

/**
 * The names each root is exported under: `validate_` and the root's name, with each character that cannot appear in a name
 * turned into `_`, and the names of its fast check and passes (`is_`, `structure_`, `predicates_`) from the same stem. The
 * names come from the root alone, so adding a root renames no other export, unless its name becomes an identifier another
 * root already has: roots whose names become the same identifier are told apart by a number from 2, handed out in the order
 * of the roots' own names, so the numbers of that set can shift.
 */
export function exportNames(rootNames: Iterable<string>): ReadonlyMap<string, RootExportNames> {
  const names = [...new Set(rootNames)].sort(compareText);
  const taken = new Set<string>();
  const result = new Map<string, RootExportNames>();
  for (const name of names) {
    const base = identifier(name);
    let stem = base;
    for (let suffix = 2; taken.has(stem); suffix++) stem = `${base}_${suffix}`;
    taken.add(stem);
    result.set(name, { validate: `validate_${stem}`, fast: `is_${stem}`, passes: { structure: `structure_${stem}`, predicates: `predicates_${stem}` } });
  }
  return result;
}

/**
 * The name of the function written at position `index` among the functions the module keeps (`f3_User`), or of its fast
 * check (`is3_User`). The index keeps names unique; the schema's name, when it has one, shows in stack traces and profiles.
 */
function functionName(index: number, schemaName: string | undefined, form: CheckForm): string {
  const prefix = form === 'fast' ? 'is' : 'f';
  return schemaName === undefined ? `${prefix}${index}` : `${prefix}${index}_${identifier(schemaName).slice(0, NAME_LIMIT)}`;
}

function writeFunction(state: ModuleState, module: IrModule, target: (id: number) => number, calleeSlot: CalleeSlot, fn: IrFunction, mode: WriterMode): WrittenFunction {
  const writer = new FunctionWriter(state, module.functions, target, fn, mode, calleeSlot);
  const body = writer.write();
  return { id: fn.id, parameters: functionParameters(fn, state.notation, name => writer.reads(name)), body, calls: writer.calls };
}

function writeFastCheck(state: ModuleState, module: IrModule, target: (id: number) => number, calleeSlot: CalleeSlot, fn: IrFunction, mode: WriterMode): WrittenFastCheck {
  const writer = new FunctionWriter(state, module.functions, target, fn, mode, calleeSlot);
  const body = writer.write();
  return { parameter: code`${valueParameter(name => writer.reads(name))}${state.notation.value}`, body, calls: writer.calls, fastCalls: writer.fastCalls };
}

/** A root that validates conjunctively (see `conjunctiveValidation`) and has a structure check: the functions of its two passes. */
interface PassRoot {
  readonly name: string;
  readonly structure: number;
  readonly predicates: number;
}

/** What every step of `emit` reads: the module with the functions of the passes added, how its functions forward, and which fast checks are planned. */
interface Emission {
  readonly module: IrModule;
  readonly target: (id: number) => number;
  readonly plan: FastPlan | undefined;
  readonly fastMode: WriterMode | undefined;
  readonly slots: FunctionSlots;
  readonly notation: Notation;
  /** The roots that export a fast check. */
  readonly fastRootExports: IrModule['exports'];
  /** The roots that export a structure check and a predicates-only pass. */
  readonly passRoots: readonly PassRoot[];
}

/**
 * The functions the roots reach, grouped: the function that stays for each group, and the fast checks written. A
 * structure check is a fast check with no full validator beside it, so `kept` and `fastKept` can differ in both directions.
 */
interface Reached {
  readonly fastReached: ReadonlySet<number>;
  readonly representative: ReadonlyMap<number, number>;
  /** The groups whose full validator is written. */
  readonly kept: readonly number[];
  /** The groups whose fast check is written. */
  readonly fastKept: ReadonlySet<number>;
}

function startEmission(whole: IrModule, { fastPath, level, language }: EmitOptions): Emission {
  const source = level === 'sanity' ? sanitize(whole) : whole;
  // A set of root names is any `ReadonlySet`, not only a `Set`.
  const wantsFastCheck = (name: string): boolean => fastPath === 'all' || (fastPath !== undefined && fastPath.has(name));
  const wanted = fastPath === 'all' || (fastPath !== undefined && fastPath.size > 0);
  const sourceTarget = forwardingTarget(source.functions);
  // The passes are IR functions of their own, so the plan and the writers treat them as any other function.
  const passes = wanted ? projectPasses(source.functions, source.exports.filter(({ name }) => wantsFastCheck(name)).map(({ fn }) => sourceTarget(fn))) : undefined;
  // A sanity module holds no check to skip, so no function takes the flag.
  const withPasses = passes === undefined ? source.functions : passes.functions;
  const module = { ...source, functions: level === 'sanity' ? withPasses : markSanity(withPasses) };
  const target = forwardingTarget(module.functions);
  const plan = wanted ? new FastPlan(module.functions) : undefined;
  return {
    module,
    target,
    plan,
    fastMode: plan === undefined ? undefined : fastCheckMode(plan),
    slots: new FunctionSlots(module.functions),
    notation: NOTATIONS[language],
    fastRootExports: module.exports.filter(({ name, fn }) => wantsFastCheck(name) && (plan?.has(target(fn)) ?? false)),
    passRoots: passes === undefined ? [] : module.exports.flatMap(({ name, fn }): PassRoot[] => {
      const structure = passes.structure.get(sourceTarget(fn));
      const predicates = passes.predicates.get(sourceTarget(fn));
      return wantsFastCheck(name) && structure !== undefined && predicates !== undefined && (plan?.has(target(structure)) ?? false) ? [{ name, structure, predicates }] : [];
    }),
  };
}

/** First pass: every function as code, to learn which of those the roots reach are the same. */
function surveyFunctions({ module, target, plan, fastMode, slots, notation }: Emission): ReadonlyMap<number, WrittenFunction> {
  const survey = new ModuleState(notation);
  survey.importValidations(module.validations);
  const ownSlot: CalleeSlot = (id, form) => slots.of(id, form);
  return new Map(module.functions.filter(fn => target(fn.id) === fn.id).map(fn => [fn.id, {
    ...writeFunction(survey, module, target, ownSlot, fn, FULL_VALIDATOR),
    ...(fastMode !== undefined && (plan?.has(fn.id) ?? false) ? { fast: writeFastCheck(survey, module, target, ownSlot, fn, fastMode) } : {}),
  }] as const));
}

function reachedFunctions({ module, target, slots, fastRootExports, passRoots }: Emission, written: ReadonlyMap<number, WrittenFunction>): Reached {
  const fastReached = reachable([...fastRootExports.map(({ fn }) => target(fn)), ...passRoots.map(({ structure }) => target(structure))], id => written.get(id)?.fast?.fastCalls ?? []);
  const reached = reachable(
    [...module.exports.map(({ fn }) => target(fn)), ...passRoots.map(({ predicates }) => target(predicates)), ...[...fastReached].flatMap(id => [...(written.get(id)?.fast?.calls ?? [])])],
    id => written.get(id)?.calls ?? [],
  );
  const representative = groupFunctions([...written.values()].filter(entry => reached.has(entry.id) || fastReached.has(entry.id)), fastReached, slots);
  return {
    fastReached,
    representative,
    kept: [...new Set([...reached].map(id => representative.get(id) ?? id))].sort((first, second) => first - second),
    fastKept: new Set([...fastReached].map(id => representative.get(id) ?? id)),
  };
}

/** The names of the functions that stay, and of their fast checks. */
function declareFunctionNames({ module, slots }: Emission, { kept, fastKept }: Reached): NameTable {
  const names = new NameTable();
  const keptFull = new Set(kept);
  [...new Set([...kept, ...fastKept])].sort((first, second) => first - second).forEach((id, index) => {
    if (keptFull.has(id)) names.declare(slots.of(id, 'full'), functionName(index, module.functions[id].name, 'full'));
    if (fastKept.has(id)) names.declare(slots.of(id, 'fast'), functionName(index, module.functions[id].name, 'fast'));
  });
  return names;
}

/** The slot of the function that stays, which every call of the functions grouped with it names: a name has one slot. */
function stayingSlotOf({ slots }: Emission, { representative }: Reached): CalleeSlot {
  return (id, form) => {
    const staying = representative.get(id);
    if (staying === undefined) throw new Error(`The validator compiler has no emitted function for the schema function ${id}.`);
    return slots.of(staying, form);
  };
}

/** Second pass: only the functions that stay, so the constants and helpers are those they use. */
function writeStaying({ module, target, fastMode, slots, notation }: Emission, { kept, fastKept }: Reached, stayingSlot: CalleeSlot): { readonly state: ModuleState; readonly functions: readonly Code[]; readonly fastFunctions: readonly Code[] } {
  const state = new ModuleState(notation);
  state.importValidations(module.validations);
  const functions = kept.map(id => {
    const { parameters, body } = writeFunction(state, module, target, stayingSlot, module.functions[id], FULL_VALIDATOR);
    return code`function ${nameOf(slots.of(id, 'full'))}(${parameters})${notation.verdict} {\n${body}`;
  });
  const fastFunctions = fastMode === undefined ? [] : [...fastKept].sort((first, second) => first - second).map(id => {
    const { parameter, body } = writeFastCheck(state, module, target, stayingSlot, module.functions[id], fastMode);
    return code`function ${nameOf(slots.of(id, 'fast'))}(${parameter})${notation.verdict} {\n${body}`;
  });
  return { state, functions, fastFunctions };
}

/** The exported wrappers of the roots, of the fast checks and of the passes. */
interface Exported {
  readonly wrappers: readonly Code[];
  readonly fastWrappers: readonly Code[];
  readonly passWrappers: readonly Code[];
  readonly fastExports: ReadonlyMap<string, string>;
  readonly passExports: ReadonlyMap<string, PassExports>;
}

/** The exported wrapper of each root, of each fast check, and of each root's two passes. */
function writeExports({ module, target, fastRootExports, passRoots, notation }: Emission, stayingSlot: CalleeSlot): Exported {
  const exported = exportNames(module.exports.map(({ name }) => name));
  const exportsOf = (name: string): RootExportNames => {
    const known = exported.get(name);
    if (known === undefined) throw new Error(`The validator compiler has no export name for the root ${JSON.stringify(name)}.`);
    return known;
  };
  // The wrapper takes the sanity flag as its third argument when its function does; see `Validator`.
  const issuesOf = (name: string, id: number): Code => {
    const sanity = module.functions[target(id)].sanity === true;
    return code`export function ${identifierCode(name)}(value${notation.value}, all${notation.all}${sanity ? code`, ${SANITY}${notation.sanity}` : code``})${notation.wrapperResult} {
  const issues${notation.issues} = [];
  ${callFunction(module.functions[target(id)], nameOf(stayingSlot(target(id), 'full')), { value: identifierCode('value'), path: code`[]`, issues: identifierCode('issues'), all: identifierCode('all') })};
  return issues;
}`;
  };
  const wrappers = module.exports.map(({ name, fn }) => issuesOf(exportsOf(name).validate, fn));
  const fastNamed = fastRootExports.map(({ name, fn }) => ({ name, fn, exportName: exportsOf(name).fast }));
  const fastExports = new Map(fastNamed.map(({ name, exportName }) => [name, exportName] as const));
  // The fast check itself is the export: a valid value takes no extra call.
  const fastWrappers = fastNamed.map(({ fn, exportName }) => code`export const ${identifierCode(exportName)}${notation.fastCheck} = ${nameOf(stayingSlot(target(fn), 'fast'))};`);
  const passNamed = passRoots.map(({ name, structure, predicates }) => ({ name, structure, predicates, passNames: exportsOf(name).passes }));
  const passExports = new Map(passNamed.map(({ name, passNames }) => [name, passNames] as const));
  const passWrappers = passNamed.flatMap(({ structure, predicates, passNames }) => [
    code`export const ${identifierCode(passNames.structure)}${notation.fastCheck} = ${nameOf(stayingSlot(target(structure), 'fast'))};`,
    issuesOf(passNames.predicates, predicates),
  ]);
  return { wrappers, fastWrappers, passWrappers, fastExports, passExports };
}

/**
 * Emits the module: one function per distinct behavior and one exported wrapper per root, named by `exportNames`.
 * Every check is written once: a forwarding function, and a function the same as another, are not emitted, and
 * their callers call the one that is. With `fastPath`, each root that has a fast check (see `FastPlan`) also exports
 * `is_X`, and only the fast checks those reach are written. A root that validates conjunctively (see `projectPasses`)
 * and whose structure has a fast check also exports `structure_X` and `predicates_X`.
 */
export function emit(module: IrModule, options: EmitOptions): EmitResult {
  const emission = startEmission(module, options);
  const reached = reachedFunctions(emission, surveyFunctions(emission));
  const stayingSlot = stayingSlotOf(emission, reached);
  const names = declareFunctionNames(emission, reached);
  const { state, functions, fastFunctions } = writeStaying(emission, reached, stayingSlot);
  const { wrappers, fastWrappers, passWrappers, fastExports, passExports } = writeExports(emission, stayingSlot);
  // The imports and the helpers come from the parts of everything the file holds.
  const contents = [...state.constantDeclarations(), ...functions, ...fastFunctions, ...wrappers, ...fastWrappers, ...passWrappers];
  const everything = join(contents, NEWLINE);
  return {
    source: render(join([
      ...runtimeImports(everything, { ...(options.specifiers === undefined ? {} : { specifiers: options.specifiers }), quote: '"' }),
      ...state.validationImports(),
      ...helperDefinitions(everything),
      ...contents,
      code``,
    ], NEWLINE), names),
    fastExports,
    passExports,
  };
}
