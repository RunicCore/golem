import { code, identifier as identifierCode, join, nameSlot, type Code, type NameSlot } from '../code.js';
import type { IrFunction } from './ir.js';

// Parameters of every generated function: the value, the path stack, the issue list and the all-errors flag,
// then, for a function that reaches a check the sanity level skips, the sanity flag, then, for a function that receives
// an evaluation record (see `IrFunction`), the caller's record. Every call and
// header goes through `functionParameters` and `callFunction`, so a change to the parameter list is made in one place.
export const VALUE = identifierCode('v');
export const PATH = identifierCode('p');
export const NEWLINE = code`\n`;
export const COMMA = code`, `;
export const ISSUES = identifierCode('i');
export const ALL = identifierCode('a');
/** True when only the shape is checked; a check of a value limit does not run. Absent or false: every check runs. */
export const SANITY = identifierCode('s');
export const INHERITED = identifierCode('e');
// The record a function keeps or fills, and what it holds.
export const EVALUATION = identifierCode('r');

export function functionParameters(fn: IrFunction): Code {
  return join([VALUE, PATH, ISSUES, ALL, ...(fn.sanity ? [SANITY] : []), ...(fn.receives ? [INHERITED] : [])], COMMA);
}

/**
 * The name slot of each function and of its fast check. A body names a callee by its slot, because the name depends on
 * which functions turn out to be one: the survey writes every function against its own slots, and the final pass writes
 * each call against the slots of the function that stays (see `groupFunctions`), so a name has one slot.
 */
export class FunctionSlots {
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
export type CalleeSlot = (id: number, fast: boolean) => NameSlot;

export interface CallArguments {
  readonly value: Code;
  readonly path?: Code;
  readonly issues: Code;
  readonly all: Code;
  /** The record to hand to the callee; dropped when the callee takes none. */
  readonly record?: Code;
  /** The callee checks the shape only whatever the caller's flag is (`IrCall.capped`): it gets `true` as the flag. */
  readonly capped?: true;
}

export function callFunction(callee: IrFunction, name: Code, args: CallArguments): Code {
  const record = callee.receives && args.record !== undefined ? [args.record] : [];
  // The caller of a callee with the flag has it too, unless the call is capped: it reaches what the callee reaches. The flag comes before the record.
  const sanity = callee.sanity ? [args.capped ? code`true` : SANITY] : [];
  return code`${name}(${join([args.value, args.path ?? PATH, args.issues, args.all, ...sanity, ...record], COMMA)})`;
}
