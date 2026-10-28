import { code, helper, helperName, join, literal as literalCode, type Code, type Helper } from '../code.js';
import { MODEL_CODEC_IDS_KEY } from '../../schema-keywords.js';
import { instanceFieldsCode, ownEnumerableCode } from '../union-conversion.js';
import { NEWLINE } from './function-names.js';

type LocalHelper = 'isPresent' | 'definedKeys' | 'readAll' | 'isObject' | 'instanceFields' | 'isInstanceState' | 'isMultipleOf' | 'selectedModel' | 'newEvaluation' | 'mergeEvaluation' | 'leafPasses';

/** A helper function of a generated module: the file holds its definition once, where the code that names it asks for it. */
function localHelper(id: LocalHelper, rank: number, define: (self: Code) => Code): Helper {
  const made: Helper = helper(id, () => define(helperName(made)), rank);
  return made;
}

/** The name of a local helper, and the request that the file defines it. */
export function localName(name: LocalHelper): Code {
  return helperName(HELPERS[name]);
}

// The rank of a helper is its place in the module: helpers come in this order, after the helpers their definitions name.
const HELPERS: Readonly<Record<LocalHelper, Helper>> = {
  // The JSON view: a key is present when it is own, enumerable and not `undefined`, as `JSON.stringify` writes it. A
  // model's optional field may be set to `undefined` and JSON has no such value.
  definedKeys: localHelper('definedKeys', 0, self => code`const ${self} = value => Object.keys(value).filter(key => value[key] !== undefined);`),
  // The failure of a fast check whose key test left the values unread reads them as the full validator does, then fails.
  readAll: localHelper('readAll', 1, self => code`function ${self}(value, keys) { for (const key of keys) value[key]; }`),
  isPresent: localHelper('isPresent', 2, self => code`const ${self} = (value, key) => ${ownEnumerableCode(code`value`, code`key`)} && value[key] !== undefined;`),
  isObject: localHelper('isObject', 3, self => code`const ${self} = value => typeof value === 'object' && value !== null && !Array.isArray(value);`),
  // An own key that the value's own model does not declare is program state, never an unknown key (see `instanceFieldsCode`).
  instanceFields: localHelper('instanceFields', 4, () => instanceFieldsCode()),
  isInstanceState: localHelper('isInstanceState', 5, self => code`function ${self}(value, key) { const fields = ${localName('instanceFields')}(value); return fields !== undefined && !fields.includes(key); }`),
  // A number is judged by the decimal digits JSON writes for it (its shortest text), so 0.3 is a multiple of 0.1 although
  // 0.3 / 0.1 is off by rounding, and 3.000000000000001 is not a multiple of 1. A whole divisor needs a whole value and an
  // exact remainder. Any other divisor compares both numbers as integers scaled by the smaller decimal exponent.
  isMultipleOf: localHelper('isMultipleOf', 6, self => join([
    code`function ${self}(value, divisor) {`,
    code`  if (Number.isInteger(divisor)) return Number.isInteger(value) && value % divisor === 0;`,
    code`  if (!Number.isFinite(value)) return false;`,
    code`  const split = number => {`,
    code`    const match = /^-?([0-9]+)(?:[.]([0-9]+))?(?:e([+-][0-9]+))?$/.exec(String(number));`,
    code`    const fraction = match[2] || '';`,
    code`    return [BigInt(match[1] + fraction), Number(match[3] || 0) - fraction.length];`,
    code`  };`,
    code`  const [valueDigits, valueExponent] = split(value);`,
    code`  const [divisorDigits, divisorExponent] = split(divisor);`,
    code`  const exponent = Math.min(valueExponent, divisorExponent);`,
    code`  const scale = shift => BigInt(10) ** BigInt(shift - exponent);`,
    code`  return (valueDigits * scale(valueExponent)) % (divisorDigits * scale(divisorExponent)) === BigInt(0);`,
    code`}`,
  ], NEWLINE)),
  // The registered model class a value is an instance of, as `golemModelInstance` reads it. The symbol key is
  // `MODEL_CODEC_IDS_KEY`, which object-codec.ts registers under: the generated module imports nothing that registers classes. The most derived
  // registered prototype on the chain wins. A codec id matches exactly: the validation plan has resolved each name to the
  // id the class registers under. The key is read once at load and no function is made per call.
  selectedModel: localHelper('selectedModel', 8, self => join([
    code`const modelIdsKey = Symbol.for(${literalCode(MODEL_CODEC_IDS_KEY)});`,
    code`function ${self}(value, among) {`,
    code`  if (typeof value !== 'object' || value === null) return undefined;`,
    code`  for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {`,
    code`    if (!Object.hasOwn(prototype, modelIdsKey)) continue;`,
    code`    const registered = prototype[modelIdsKey];`,
    code`    for (let x = 0; x < among.length; x++) for (let y = 0; y < registered.length; y++) if (registered[y] === among[x]) return among[x];`,
    code`  }`,
    code`  return undefined;`,
    code`}`,
  ], NEWLINE)),
  // What the keywords of one value evaluated: keys by name, or all of them; leading items by count, others by
  // index, or all of them.
  newEvaluation: localHelper('newEvaluation', 9, self => code`const ${self} = () => ({ keys: new Set(), allKeys: false, prefix: 0, indexes: new Set(), allItems: false });`),
  mergeEvaluation: localHelper('mergeEvaluation', 10, self => join([
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
  leafPasses: localHelper('leafPasses', 11, self => join([
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
export function stateTest(fields: Code, key: Code): Code {
  return code`${fields} !== undefined && !${fields}.includes(${key})`;
}

/**
 * True when `key` is program state, with `fields` read on first use: a local declared with `let`, `undefined` until a
 * key needs it, then the names or `false` for a value without program state. The lookup runs once for the object, also
 * for a plain value. A value whose keys the schema all names never reads them, so a failing check of a model instance
 * does not walk its prototypes.
 */
export function lazyStateTest(fields: Code, value: Code, key: Code, instanceFields: Code): Code {
  return code`(${fields} === undefined ? (${fields} = ${instanceFields}(${value}) ?? false) : ${fields}) !== false && !${fields}.includes(${key})`;
}
