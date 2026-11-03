/**
 * A built-in generator writes code that imports the internal runtime entries of `@exprtlabs/golem` (`@exprtlabs/golem/internal/*`).
 * Those entries may change in any release, so a built-in generator works with the runtime of its own version only.
 */
export function assertRuntimeCompatible(
  runtime: { readonly name: string; readonly version: string },
  generator: { readonly name: string; readonly version: string },
): void {
  if (runtime.version === generator.version) return;
  throw new Error(`${runtime.name} ${runtime.version} and ${generator.name} ${generator.version} must have the same version. Run: npm install -D ${generator.name}@${runtime.version}`);
}
