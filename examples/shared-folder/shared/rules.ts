// A rule function for a field. Golem imports it by relative path.
export function isCurrencyCode(value: string): boolean | string {
  return /^[A-Z]{3}$/.test(value) || 'Enter a three-letter currency code.';
}
