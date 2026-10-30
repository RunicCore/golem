import type { IrArray, IrCheck, IrFunction, IrModule, IrObject, IrSchema } from './ir.js';

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
      case 'type': case 'literal': case 'format': case 'string': case 'number': case 'date': case 'class': case 'instance': case 'call': case 'union':
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
    case 'type': case 'literal': case 'format': case 'string': case 'number': case 'allOf': case 'date': case 'class': case 'instance':
    case 'unevaluatedProperties': case 'unevaluatedItems':
      return [];
  }
}

/** `seed` and every caller of its members, by `callers` (callee to callers). */
function withCallers(seed: Iterable<number>, callers: ReadonlyMap<number, readonly number[]>): Set<number> {
  return reachable(seed, id => callers.get(id) ?? []);
}

/** Records `caller` among the callers of `callee`. */
function addCaller(callers: Map<number, number[]>, callee: number, caller: number): void {
  const known = callers.get(callee);
  if (known === undefined) callers.set(callee, [caller]);
  else known.push(caller);
}

/** The functions whose IR call graph reaches a check for which `direct` holds, and those functions' callers. */
function reaching(functions: readonly IrFunction[], direct: (check: IrCheck) => boolean): ReadonlySet<number> {
  const callers = new Map<number, number[]>();
  const found = new Set<number>();
  for (const fn of functions) {
    visitChecks(fn.body, check => {
      if (direct(check)) found.add(fn.id);
      for (const callee of calledFunctions(check)) addCaller(callers, callee, fn.id);
    });
  }
  return withCallers(found, callers);
}

/** The functions whose IR call graph reaches a validation function. These have no fast check, so each predicate runs once per conversion. */
export function reachingValidation(functions: readonly IrFunction[]): ReadonlySet<number> {
  return reaching(functions, check => check.kind === 'validation');
}

/** An array with a prefix or a closed end is a tuple: only its arity is shape. Any other count of items is a limit. */
export const isTuple = (check: IrArray): boolean => check.prefixItems.length > 0 || check.closed;

/**
 * True when the sanity level keeps the format. Only `date-time` stays: the schema has no mark for a field that converts to
 * a `Date`, and its converter reads the text with the same rule, so a bad text answers a validation issue that names the
 * field. The converters of `Date` and Temporal check their own wire form at every level (F-39).
 */
export const keepsFormat = (format: string): boolean => format === 'date-time';

/**
 * The one list of what the sanity level skips: the check without its value limits (a string length or pattern, a number
 * range or `multipleOf`, a format other than `date-time`, a count of items outside a tuple, `uniqueItems`, a count of
 * `contains` matches above one, a count of properties) and without its validation functions. It is the same check when
 * it holds none, and undefined when nothing is left. Sanity keeps the shape: the type, the keys, the union tags, the
 * enums and constants, a tuple's arity.
 */
function withoutLimits(check: IrCheck): IrCheck | undefined {
  switch (check.kind) {
    case 'string': case 'number': return undefined;
    case 'format': return keepsFormat(check.format) ? check : undefined;
    case 'validation': return check.calls.length === 0 ? check : check.fn === undefined ? undefined : { kind: 'call', fn: check.fn };
    case 'array': {
      const { minItems, maxItems, contains, ...rest } = check;
      const arity = isTuple(check);
      const counts = contains !== undefined && (contains.min > 1 || contains.max !== undefined);
      if (!check.uniqueItems && !counts && (arity || (minItems === undefined && maxItems === undefined))) return check;
      return {
        ...rest,
        uniqueItems: false,
        ...(arity && minItems !== undefined ? { minItems } : {}),
        ...(arity && maxItems !== undefined ? { maxItems } : {}),
        ...(contains === undefined ? {} : { contains: { fn: contains.fn, min: Math.min(contains.min, 1) } }),
      };
    }
    case 'object': {
      const { minProperties, maxProperties, ...rest } = check;
      return minProperties === undefined && maxProperties === undefined ? check : rest;
    }
    case 'type': case 'literal': case 'date': case 'class': case 'instance': case 'call': case 'allOf': case 'union': case 'not':
    case 'conditional': case 'dependentSchemas': case 'unevaluatedProperties': case 'unevaluatedItems':
      return check;
    default: return unprojected(check);
  }
}

/** True when the sanity level skips something of this check (see `withoutLimits`). */
const skipsCheck = (check: IrCheck): boolean => withoutLimits(check) !== check;

/**
 * The functions that reach a check the sanity level skips (see `skipsCheck`): they take the flag `s`. A function that
 * reaches one through `not`, `if`, `oneOf` or `contains` too, so the monotone rule (sanity accepts all that full accepts)
 * can relax those.
 */
function reachingSkipped(functions: readonly IrFunction[]): ReadonlySet<number> {
  return reaching(functions, skipsCheck);
}

/** The functions, each marked `sanity` when it reaches a check the sanity level skips. */
export function markSanity(functions: readonly IrFunction[]): readonly IrFunction[] {
  const reached = reachingSkipped(functions);
  return functions.map(fn => (reached.has(fn.id) ? { ...fn, sanity: true } : fn));
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
function conjunctiveValidation(functions: readonly IrFunction[]): ReadonlySet<number> {
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
        if (callee === conjunctiveTarget) addCaller(callers, callee, fn.id);
        else spoiled.add(fn.id);
      }
    });
  }
  const tainted = withCallers(spoiled, callers);
  return new Set([...reaching].filter(id => !tainted.has(id)));
}

/** The functions of `functions` plus the two passes of the roots that validate conjunctively. */
interface PassFunctions {
  readonly functions: readonly IrFunction[];
  /** For a function the passes cover: its structure check, the function with every validation function left out. */
  readonly structure: ReadonlyMap<number, number>;
  /** For a function the passes cover: its predicates-only pass, which runs each validation function once and reports the issues of the full validator for a value whose structure is valid. */
  readonly predicates: ReadonlyMap<number, number>;
}

const ALWAYS: IrSchema = { kind: 'always' };

/** A new kind of check fails the build here, and generation, instead of being dropped from a pass. */
function unprojected(check: never): never {
  throw new Error(`The validator compiler projects no check of the kind ${JSON.stringify(check)}.`);
}

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
      case 'type': case 'literal': case 'format': case 'string': case 'number': case 'date': case 'class': case 'instance': case 'union':
      case 'not': case 'conditional': case 'dependentSchemas': case 'unevaluatedProperties': case 'unevaluatedItems':
        return [check];
      default: return unprojected(check);
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
        const items = check.items === undefined ? undefined : predicateSchema(check.items);
        // The items loop starts after the last prefix item, so a prefix item that is dropped keeps its place while `items` is kept.
        while (items === undefined && prefixItems.at(-1)?.kind === 'always') prefixItems.pop();
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
      case 'type': case 'literal': case 'format': case 'string': case 'number': case 'date': case 'class': case 'instance': case 'union':
      case 'not': case 'conditional': case 'dependentSchemas': case 'unevaluatedProperties': case 'unevaluatedItems':
        return [];
      default: return unprojected(check);
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

/**
 * The module as the sanity level checks it: the shape only, with no `s` flag. What `withoutLimits` names is left out. A
 * check that would reject more once its callee is relaxed is relaxed too, so sanity accepts all that full accepts:
 * `not` is left out, an untagged `oneOf` becomes an `anyOf`, `if` stops deciding when its own schema reaches a skipped
 * check (`IrConditional.relaxed`), and `contains` needs one match at most, or none. Each such check is judged on the
 * full module's reach, before anything is left out. A check that has nothing left to fail is left out too, unless
 * `unevaluatedProperties` or `unevaluatedItems` reads what it marks.
 */
export function sanitize(module: IrModule): IrModule {
  const reached = reachingSkipped(module.functions);
  const relaxes = (ids: readonly (number | undefined)[]): boolean => ids.some(id => id !== undefined && reached.has(id));
  // The functions whose schema is left with nothing to check: `propertyNames` need not call them.
  let voided: ReadonlySet<number> = new Set();
  /** `record`: the value's function keeps or receives an evaluation record, so its checks mark what they evaluate. */
  const schemaOf = (schema: IrSchema, record: boolean): IrSchema => {
    if (schema.kind !== 'checks') return schema;
    const checks = schema.checks.flatMap(check => sanityCheck(check, record, schema.checks));
    return checks.length === 0 ? ALWAYS : { kind: 'checks', checks };
  };
  const sanityCheck = (original: IrCheck, record: boolean, siblings: readonly IrCheck[]): IrCheck[] => {
    const check = withoutLimits(original);
    if (check === undefined) return [];
    switch (check.kind) {
      case 'not': return relaxes([check.fn]) ? [] : [check];
      case 'union': return check.exactlyOne && relaxes(check.branches) ? [{ ...check, exactlyOne: false }] : [check];
      case 'conditional': return relaxes([check.if]) ? [{ ...check, relaxed: true }] : [check];
      case 'allOf': return [{ ...check, branches: check.branches.map(branch => schemaOf(branch, record)) }];
      case 'unevaluatedProperties': case 'unevaluatedItems': return [{ ...check, schema: schemaOf(check.schema, false) }];
      case 'array': {
        const { contains, ...rest } = check;
        // A relaxed `contains` only marks its matches, and only a function that keeps a record reads them.
        const kept = contains === undefined || (relaxes([contains.fn]) && !record) ? undefined : relaxes([contains.fn]) ? { fn: contains.fn, min: 0 } : contains;
        const array: IrArray = {
          ...rest,
          prefixItems: check.prefixItems.map(item => schemaOf(item, false)),
          ...(check.items === undefined ? {} : { items: schemaOf(check.items, false) }),
          ...(kept === undefined ? {} : { contains: kept }),
        };
        // What is left is the loop that finds a hole, which a schema of type `array` wants and a limit alone did not.
        const marks = record && (array.prefixItems.length > 0 || array.items !== undefined);
        const bare = !array.closed && kept === undefined && array.minItems === undefined && array.maxItems === undefined && !marks
          && array.prefixItems.every(item => item.kind === 'always') && (array.items === undefined || array.items.kind === 'always')
          && !siblings.some(sibling => sibling.kind === 'type' && sibling.names.includes('array'));
        return bare ? [] : [array];
      }
      case 'object': {
        const object: IrObject = {
          ...check,
          properties: check.properties.map(property => ({ ...property, schema: schemaOf(property.schema, false) })),
          patternProperties: check.patternProperties.map(entry => ({ ...entry, schema: schemaOf(entry.schema, false) })),
          ...(check.additional?.kind === 'schema' ? { additional: { kind: 'schema' as const, schema: schemaOf(check.additional.schema, false) } } : {}),
          ...(check.propertyNames !== undefined && voided.has(check.propertyNames) ? { propertyNames: undefined } : {}),
        };
        const quiet = (schema: IrSchema): boolean => schema.kind === 'always';
        const bare = object.required.length === 0 && object.dependentRequired.every(entry => entry.keys.length === 0)
          && object.properties.every(property => quiet(property.schema)) && object.patternProperties.every(entry => quiet(entry.schema))
          && (object.additional === undefined || (object.additional.kind === 'schema' && quiet(object.additional.schema)))
          && object.propertyNames === undefined && !(record && (object.properties.length > 0 || object.patternProperties.length > 0 || object.additional !== undefined));
        return bare ? [] : [object];
      }
      default: return [check];
    }
  };
  const convert = (functions: readonly IrFunction[]): IrFunction[] => functions.map(fn => ({ ...fn, body: schemaOf(fn.body, fn.collects || fn.receives) }));
  const first = convert(module.functions);
  voided = new Set(first.filter(fn => fn.body.kind === 'always').map(fn => fn.id));
  // No validation function is left to call, so the module imports none.
  return { ...module, validations: [], functions: voided.size === 0 ? first : convert(first) };
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
