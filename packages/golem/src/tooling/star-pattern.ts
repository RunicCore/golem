/**
 * What the `*` of `pattern` matched in `name`, with `''` for a pattern with no `*` that equals `name`; undefined when `name` does not match.
 * The form of a `paths` key and of an `imports` key of a package.json.
 */
export function matchStarPattern(pattern: string, name: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star < 0) return name === pattern ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  // The prefix and the suffix may not overlap in `name`, as in TypeScript's own `paths` match.
  if (name.length < prefix.length + suffix.length || !name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
  return name.slice(prefix.length, name.length - suffix.length);
}
