import type { IrCheck, IrFunction, IrSchema } from './ir.js';

/**
 * The function that stands for `id`: a function whose body only passes the value to another one (a `$ref`, or a
 * schema that is nothing else) is that other function. It must take the evaluation record the other takes, so a
 * caller passes the same arguments either way.
 */
export function forwardingTarget(functions: readonly IrFunction[]): (id: number) => number {
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
export function reachingValidation(functions: readonly IrFunction[]): ReadonlySet<number> {
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


/** The ids reachable from `start` through `next`. */
export function reachable(start: Iterable<number>, next: (id: number) => Iterable<number>): Set<number> {
  const reached = new Set<number>();
  const pending = [...start];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...next(id));
  }
  return reached;
}
