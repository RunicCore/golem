import { code, type Code } from '../code.js';
import { rt } from '../rt.js';

const runtime = rt['validation-runtime'];

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
