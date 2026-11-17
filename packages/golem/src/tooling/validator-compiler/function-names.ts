import { code, identifier as identifierCode, join, nameSlot, type Code, type NameSlot } from '../code.js';
import { rtType } from '../rt.js';
import type { IrFunction } from './ir.js';
import type { Language } from './options.js';

// Parameters of every generated function: the value, the path stack, the issue list and the all-errors flag,
// then, for a function that reaches a check the sanity level skips, the sanity flag, then, for a function that receives
// an evaluation record (see `IrFunction`), the caller's record. Every call and
// header goes through `functionParameters` and `callFunction`, so a change to the parameter list is made in one place.

/** A parameter of a generated function, and the name it takes when the body never reads it: a name that starts with `_` is left alone by the checker's unused-parameter rule. */
interface Parameter {
  readonly name: Code;
  readonly unread: Code;
}

function parameter(letter: string): Parameter {
  return { name: identifierCode(letter), unread: identifierCode(`_${letter}`) };
}

const VALUE_PARAMETER = parameter('v');
const PATH_PARAMETER = parameter('p');
const ISSUES_PARAMETER = parameter('i');
const ALL_PARAMETER = parameter('a');
const SANITY_PARAMETER = parameter('s');
const INHERITED_PARAMETER = parameter('e');

export const VALUE = VALUE_PARAMETER.name;
export const PATH = PATH_PARAMETER.name;
export const NEWLINE = code`\n`;
export const COMMA = code`, `;
export const ISSUES = ISSUES_PARAMETER.name;
export const ALL = ALL_PARAMETER.name;
/** True when only the shape is checked; a check of a value limit does not run. Absent or false: every check runs. */
export const SANITY = SANITY_PARAMETER.name;
export const INHERITED = INHERITED_PARAMETER.name;
// The record a function keeps or fills, and what it holds.
export const EVALUATION = identifierCode('r');
/** The length of the path when a function started, which a failure restores. */
export const PATH_LENGTH = identifierCode('pl');

/** What a body says about the names it holds: true when a line of it reads `name`. */
export type Reads = (name: Code) => boolean;

function named(declared: Parameter, reads: Reads): Code {
  return reads(declared.name) ? declared.name : declared.unread;
}

/** The header name of the value of a fast check, which takes no other parameter. */
export function valueParameter(reads: Reads): Code {
  return named(VALUE_PARAMETER, reads);
}

/** What the generated file writes after a parameter, after a header, and after a constant besides its code: types in TypeScript, nothing in JavaScript. */
export interface Notation {
  readonly value: Code;
  readonly path: Code;
  /** The issue list parameter, and the issue list a wrapper makes. */
  readonly issues: Code;
  readonly all: Code;
  readonly sanity: Code;
  readonly record: Code;
  /** The result of a check that answers true or false: a function, and its fast check. */
  readonly verdict: Code;
  /** The result of an exported wrapper. */
  readonly wrapperResult: Code;
  /** The type of an exported fast check that is another function's name. */
  readonly fastCheck: Code;
  /** A local that holds a value read from the input, so a read from an array (`any`) is as checked as one from an object. */
  readonly read: Code;
  /** The type of a constant that holds a list of JSON values. */
  readonly literals: Code;
  /** The type of a constant that holds the tag list of each branch of a union. */
  readonly tagLists: Code;
}

const NONE = code``;

/** The one table of the two languages: the generated text names no type outside it, so a type of the header is changed in one place. */
export const NOTATIONS: Readonly<Record<Language, Notation>> = {
  ts: {
    value: code`: unknown`,
    path: code`: (string | number)[]`,
    issues: code`: ${rtType.validation.SchemaIssue}[]`,
    all: code`: boolean`,
    sanity: code`?: boolean`,
    record: code`?: ${rtType.validation.Evaluation}`,
    verdict: code`: boolean`,
    wrapperResult: code`: readonly ${rtType.validation.SchemaIssue}[]`,
    read: code`: unknown`,
    fastCheck: code`: (value: unknown) => boolean`,
    literals: code`: readonly ${rtType.validation.JsonValue}[]`,
    tagLists: code`: readonly (readonly ${rtType.validation.JsonValue}[])[]`,
  },
  js: { value: NONE, path: NONE, issues: NONE, all: NONE, sanity: NONE, record: NONE, verdict: NONE, wrapperResult: NONE, read: NONE, fastCheck: NONE, literals: NONE, tagLists: NONE },
};

export function functionParameters(fn: IrFunction, notation: Notation, reads: Reads): Code {
  return join([
    code`${named(VALUE_PARAMETER, reads)}${notation.value}`,
    code`${named(PATH_PARAMETER, reads)}${notation.path}`,
    code`${named(ISSUES_PARAMETER, reads)}${notation.issues}`,
    code`${named(ALL_PARAMETER, reads)}${notation.all}`,
    ...(fn.sanity ? [code`${named(SANITY_PARAMETER, reads)}${notation.sanity}`] : []),
    ...(fn.receives ? [code`${named(INHERITED_PARAMETER, reads)}${notation.record}`] : []),
  ], COMMA);
}

/**
 * The name slot of each function and of its fast check. A body names a callee by its slot, because the name depends on
 * which functions turn out to be one: the survey writes every function against its own slots, and the final pass writes
 * each call against the slots of the function that stays (see `groupFunctions`), so a name has one slot.
 */
/** The form of a schema function a name slot, a call or a declared name stands for: the full validator or its fast check. */
export type CheckForm = 'full' | 'fast';

export class FunctionSlots {
  private readonly full: readonly NameSlot[];
  private readonly fast: readonly NameSlot[];
  private readonly owners = new Map<NameSlot, { readonly id: number; readonly form: CheckForm }>();

  public constructor(functions: readonly IrFunction[]) {
    this.full = functions.map(fn => nameSlot(`function ${fn.id}`));
    this.fast = functions.map(fn => nameSlot(`fast check ${fn.id}`));
    functions.forEach((fn, id) => {
      this.owners.set(this.full[id], { id, form: 'full' });
      this.owners.set(this.fast[id], { id, form: 'fast' });
    });
  }

  public of(id: number, form: CheckForm): NameSlot {
    return (form === 'fast' ? this.fast : this.full)[id];
  }

  /** The function a slot belongs to, and the form its slot names. */
  public owner(slot: NameSlot): { readonly id: number; readonly form: CheckForm } | undefined {
    return this.owners.get(slot);
  }
}

/** The slot a call names: the function `id` after forwarding, or its fast check. */
export type CalleeSlot = (id: number, form: CheckForm) => NameSlot;

export interface CallArguments {
  readonly value: Code;
  readonly path?: Code;
  readonly issues: Code;
  readonly all: Code;
  /** The record to hand to the callee; dropped when the callee takes none. */
  readonly record?: Code;
}

export function callFunction(callee: IrFunction, name: Code, args: CallArguments): Code {
  const record = callee.receives && args.record !== undefined ? [args.record] : [];
  // The caller of a callee with the flag has it too: it reaches what the callee reaches. The flag comes before the record.
  const sanity = callee.sanity ? [SANITY] : [];
  return code`${name}(${join([args.value, args.path ?? PATH, args.issues, args.all, ...sanity, ...record], COMMA)})`;
}
