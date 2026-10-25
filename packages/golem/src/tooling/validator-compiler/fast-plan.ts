import type { IrCheck, IrFunction } from './ir.js';
import { reachingValidation } from './call-graph.js';

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
export class FastPlan {
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
