/**
 * Short name for an IObject/IModel alias.
 * `codecShortName` sanitizes, then uses this rule.
 * The Go plugin copies this rule in `packages/golem/plugin/main.go`.
 * Keep those three copies on the same examples.
 */
export function modelName(aliasName: string): string {
  const withoutPrefix = /^T[A-Z]/.test(aliasName) ? aliasName.slice(1) : aliasName;
  return withoutPrefix.endsWith('Model') && withoutPrefix.length > 5
    ? withoutPrefix.slice(0, -5)
    : withoutPrefix;
}
