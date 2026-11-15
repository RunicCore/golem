import { code, helper, helperName, join, literal as literalCode, type Code, type Helper } from '../code.js';
import { MODEL_CODEC_IDS_KEY } from '../../schema-keywords.js';
import { ownEnumerableCode } from '../union-conversion.js';
import { rt } from '../rt.js';
import { NEWLINE } from './function-names.js';

const runtime = rt['validation-runtime'];

type LocalHelper = 'isPresent' | 'definedKeys' | 'readAll' | 'isObject' | 'isMultipleOfScaled' | 'selectedModel' | 'newEvaluation' | 'mergeEvaluation' | 'leafPasses';

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
  // The JSON view of the keys: a key is present when it is own, enumerable and not `undefined`, as `JSON.stringify` writes
  // it. A model's optional field may be set to `undefined` and JSON has no such value. Program state of a model instance
  // (see `instanceFields`) is no key of the model, also when the schema declares a key of that name, and its value is never read.
  // `fields` are the own-model names of `value` (`instanceFieldsOf`), which the caller already holds.
  definedKeys: localHelper('definedKeys', 5, self => code`const ${self} = (value, fields) => Object.keys(value).filter(key => !${stateTest(code`fields`, code`key`)} && value[key] !== undefined);`),
  // The failure of a fast check whose key test left the values unread reads them as the full validator does, then fails.
  readAll: localHelper('readAll', 5, self => code`function ${self}(value, keys) { const fields = ${instanceFieldsOf(code`value`)}; for (const key of keys) if (!${stateTest(code`fields`, code`key`)}) value[key]; }`),
  isPresent: localHelper('isPresent', 2, self => code`const ${self} = (value, key) => ${ownEnumerableCode(code`value`, code`key`)} && !${stateTest(instanceFieldsOf(code`value`), code`key`)} && value[key] !== undefined;`),
  isObject: localHelper('isObject', 3, self => code`const ${self} = value => typeof value === 'object' && value !== null && !Array.isArray(value);`),
  // The fast form of `isMultipleOf` for a decimal divisor the compiler wrote as `units / scale` (see `scaledDivisor`). A value
  // is a multiple when it is `whole / scale` for a whole number below 2 ** 52 (4503599627370496) that `units` divides.
  // `whole / scale` is the double nearest to the decimal `whole * 10 ** -d`, and at that size no other decimal with d digits
  // after the point rounds to the same double, so `whole / scale === value` shows that the shortest text of the value is
  // that decimal and `isMultipleOf` would judge it the same way. Any value that fails the test (NaN, infinite, too large,
  // too many decimals) goes to `isMultipleOf`, so every result stays the one of the exact function. It allocates nothing.
  isMultipleOfScaled: localHelper('isMultipleOfScaled', 7, self => join([
    code`function ${self}(value, divisor, units, scale) {`,
    code`  const whole = Math.round(value * scale);`,
    code`  if (Math.abs(whole) < 4503599627370496 && whole / scale === value) return whole % units === 0;`,
    code`  return ${runtime.isMultipleOf}(value, divisor);`,
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

/**
 * The whole numbers `units` and `scale` with `divisor` equal to `units / scale` as decimal digits, `scale` a power of ten
 * that a double holds exactly, for a divisor that is not whole and whose digits `isMultipleOfScaled` can use. They come
 * from the shortest text of the divisor, as `isMultipleOf` reads it. Any other divisor has none.
 */
export function scaledDivisor(divisor: number): { readonly units: number; readonly scale: number } | undefined {
  if (!Number.isFinite(divisor) || divisor <= 0 || Number.isInteger(divisor)) return undefined;
  const match = /^([0-9]+)(?:[.]([0-9]+))?(?:e([+-][0-9]+))?$/.exec(String(divisor));
  if (match === null) return undefined;
  const fraction = match[2] ?? '';
  const units = Number(match[1] + fraction);
  const decimals = fraction.length - Number(match[3] ?? 0);
  if (!Number.isSafeInteger(units) || decimals < 1 || decimals > 22) return undefined;
  return { units, scale: Number(`1e${decimals}`) };
}

/** The names that the own model of `value` declares, or `undefined` when it holds no program state (`instanceFields`). */
export function instanceFieldsOf(value: Code): Code {
  return code`${runtime.instanceFields}(${value})`;
}

/** True when `key` is program state, given the own-model names `fields` of its value (`instanceFieldsOf`). The one writer of this test. */
export function stateTest(fields: Code, key: Code): Code {
  return code`${runtime.isStateKey}(${fields}, ${key})`;
}
