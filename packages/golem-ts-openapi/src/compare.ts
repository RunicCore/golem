/** Locale-independent ordering by UTF-16 code units, so output is identical on every machine. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
