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

/**
 * Every check of a schema, the checks of the schemas inlined in them included. `conjunctive` tells whether the check
 * judges the value together with its function's other checks: an item, a declared property and an `allOf` branch do,
 * and so does a check of the function body. The schema of a pattern, of `additionalProperties` and of `unevaluated*`
 * judges only the keys or items that nothing else judged, so a check inside it is not conjunctive.
 */
function visitChecks(schema: IrSchema, visit: (check: IrCheck, conjunctive: boolean) => void, conjunctive = true): void {
  if (schema.kind !== 'checks') return;
  for (const check of schema.checks) {
    visit(check, conjunctive);
    switch (check.kind) {
      case 'array':
        for (const item of check.prefixItems) visitChecks(item, visit, conjunctive);
        if (check.items !== undefined) visitChecks(check.items, visit, conjunctive);
        break;
      case 'object':
        for (const property of check.properties) visitChecks(property.schema, visit, conjunctive);
        for (const entry of check.patternProperties) visitChecks(entry.schema, visit, false);
        if (check.additional?.kind === 'schema') visitChecks(check.additional.schema, visit, false);
        break;
      case 'allOf':
        for (const branch of check.branches) visitChecks(branch, visit, conjunctive);
        break;
      case 'unevaluatedProperties':
      case 'unevaluatedItems':
        visitChecks(check.schema, visit, false);
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

/** `seed` and every caller of its members, by `callers` (callee to callers). */
function withCallers(seed: Iterable<number>, callers: ReadonlyMap<number, readonly number[]>): Set<number> {
  return reachable(seed, id => callers.get(id) ?? []);
}

/** The functions whose IR call graph reaches a validation function. These have no fast check, so each predicate runs once per conversion. */
export function reachingValidation(functions: readonly IrFunction[]): ReadonlySet<number> {
  const callers = new Map<number, number[]>();
  const reaching = new Set<number>();
  for (const fn of functions) {
    visitChecks(fn.body, check => {
      if (check.kind === 'validation') reaching.add(fn.id);
      for (const callee of calledFunctions(check)) callers.set(callee, [...(callers.get(callee) ?? []), fn.id]);
    });
  }
  return withCallers(reaching, callers);
}

/** The edge of a check that judges the value of its function together with the function's other checks: a reference, or the structure under a validation. */
function conjunctiveCallee(check: IrCheck): number | undefined {
  return check.kind === 'call' || (check.kind === 'validation' && check.fn !== undefined) ? calledFunctions(check)[0] : undefined;
}

/**
 * The one rule of conjunctive reach: the functions that reach a validation function, and every path to it is
 * conjunctive. A path is conjunctive when each step is a reference, the structure under a validation, an array item, a
 * declared property or an `allOf` branch, so the predicate judges the value whatever else passes. A predicate under a
 * union, `not`, `if`, `dependentSchemas`, `contains`, `propertyNames`, a pattern, `additionalProperties` or `unevaluated*`
 * is not conjunctive, and neither is one in a function that keeps or receives an evaluation record.
 */
export function conjunctiveValidation(functions: readonly IrFunction[]): ReadonlySet<number> {
  const reaching = reachingValidation(functions);
  const callers = new Map<number, number[]>();
  const spoiled = new Set<number>();
  for (const fn of functions) {
    if (!reaching.has(fn.id)) continue;
    if (fn.collects || fn.receives) spoiled.add(fn.id);
    visitChecks(fn.body, (check, conjunctive) => {
      if (check.kind === 'validation' && !conjunctive) spoiled.add(fn.id);
      const conjunctiveTarget = conjunctive ? conjunctiveCallee(check) : undefined;
      for (const callee of calledFunctions(check).filter(id => reaching.has(id))) {
        if (callee === conjunctiveTarget) callers.set(callee, [...(callers.get(callee) ?? []), fn.id]);
        else spoiled.add(fn.id);
      }
    });
  }
  const tainted = withCallers(spoiled, callers);
  return new Set([...reaching].filter(id => !tainted.has(id)));
}

/** The functions of `functions` plus the two passes of the roots that validate conjunctively. */
export interface PassFunctions {
  readonly functions: readonly IrFunction[];
  /** For a function the passes cover: its structure check, the function with every validation function left out. */
  readonly structure: ReadonlyMap<number, number>;
  /** For a function the passes cover: its predicates-only pass, which runs each validation function once and reports the issues of the full validator for a value whose structure is valid. */
  readonly predicates: ReadonlyMap<number, number>;
}

const ALWAYS: IrSchema = { kind: 'always' };

/**
 * Adds the structure check and the predicates-only pass of each function in `roots` that validates conjunctively (see
 * `conjunctiveValidation`), and of the functions it reaches. Both are ordinary IR functions: the structure check holds no
 * validation function, so the fast check plans and writes it; the predicates-only pass keeps the validation functions
 * and the path to them in the order of the full validator, so the full validator's writer reports the same issues.
 */
export function projectPasses(functions: readonly IrFunction[], roots: Iterable<number>): PassFunctions {
  const eligible = conjunctiveValidation(functions);
  const conjunctiveCallees = (id: number): number[] => {
    const callees: number[] = [];
    visitChecks(functions[id].body, (check, conjunctive) => {
      const callee = conjunctive ? conjunctiveCallee(check) : undefined;
      if (callee !== undefined && eligible.has(callee)) callees.push(callee);
    });
    return callees;
  };
  const covered = [...reachable([...roots].filter(id => eligible.has(id)), conjunctiveCallees)].sort((first, second) => first - second);
  const structure = new Map(covered.map((id, index) => [id, functions.length + 2 * index] as const));
  const predicates = new Map(covered.map((id, index) => [id, functions.length + 2 * index + 1] as const));

  const structureSchema = (schema: IrSchema): IrSchema => schema.kind !== 'checks' ? schema : { kind: 'checks', checks: schema.checks.flatMap(structureCheck) };
  const nested = (schema: IrSchema): IrSchema => {
    const projected = structureSchema(schema);
    return projected.kind === 'checks' && projected.checks.length === 0 ? ALWAYS : projected;
  };
  const structureCheck = (check: IrCheck): IrCheck[] => {
    switch (check.kind) {
      case 'validation': return check.fn === undefined ? [] : [{ kind: 'call', fn: structure.get(check.fn) ?? check.fn }];
      case 'call': return [{ ...check, fn: structure.get(check.fn) ?? check.fn }];
      case 'allOf': return [{ ...check, branches: check.branches.map(nested) }];
      case 'array': return [{ ...check, prefixItems: check.prefixItems.map(nested), ...(check.items === undefined ? {} : { items: nested(check.items) }) }];
      case 'object': return [{ ...check, properties: check.properties.map(property => ({ ...property, schema: nested(property.schema) })) }];
      default: return [check];
    }
  };

  const predicateSchema = (schema: IrSchema): IrSchema | undefined => {
    const checks = schema.kind === 'checks' ? schema.checks.flatMap(predicateCheck) : [];
    return checks.length === 0 ? undefined : { kind: 'checks', checks };
  };
  const predicateCheck = (check: IrCheck): IrCheck[] => {
    switch (check.kind) {
      case 'validation': {
        const inner = check.fn === undefined ? undefined : predicates.get(check.fn);
        return [{ kind: 'validation', ...(inner === undefined ? {} : { fn: inner }), calls: check.calls }];
      }
      case 'call': {
        const fn = predicates.get(check.fn);
        return fn === undefined ? [] : [{ kind: 'call', fn }];
      }
      case 'allOf': {
        const branches = check.branches.flatMap(branch => predicateSchema(branch) ?? []);
        return branches.length === 0 ? [] : [{ kind: 'allOf', branches }];
      }
      case 'array': {
        const prefixItems = check.prefixItems.map(item => predicateSchema(item) ?? ALWAYS);
        while (prefixItems.at(-1)?.kind === 'always') prefixItems.pop();
        const items = check.items === undefined ? undefined : predicateSchema(check.items);
        return items === undefined && prefixItems.length === 0
          ? []
          : [{ kind: 'array', prefixItems, ...(items === undefined ? {} : { items }), closed: false, uniqueItems: false }];
      }
      case 'object': {
        const properties = check.properties.flatMap(property => {
          const schema = predicateSchema(property.schema);
          return schema === undefined ? [] : [{ key: property.key, schema }];
        });
        return properties.length === 0 ? [] : [{ kind: 'object', required: [], dependentRequired: [], properties, patternProperties: [] }];
      }
      default: return [];
    }
  };

  const added = covered.flatMap((id): IrFunction[] => {
    const { name, body } = functions[id];
    const named = name === undefined ? {} : { name };
    return [
      { id: structure.get(id)!, ...named, body: { kind: 'checks', checks: body.kind === 'checks' ? body.checks.flatMap(structureCheck) : [] }, collects: false, receives: false },
      { id: predicates.get(id)!, ...named, body: predicateSchema(body) ?? { kind: 'checks', checks: [] }, collects: false, receives: false },
    ];
  });
  return { functions: [...functions, ...added], structure, predicates };
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
