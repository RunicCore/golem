import { transformSync } from 'esbuild';

/** TypeScript text as JavaScript, so a test can run or import it; `format` is ES module unless a test runs it as CommonJS. */
export function stripTypes(source: string, format?: 'cjs'): string {
  return transformSync(source, { loader: 'ts', target: 'es2022', ...(format ? { format } : {}) }).code;
}

/**
 * Runs generated or rewritten module text with `scope` as its free names and returns the values it holds under `exports`.
 * With `format: 'cjs'` the module is CommonJS: a test passes `require`, `exports` and `module` in `scope`.
 */
export function runModule(
  source: string,
  scope: Readonly<Record<string, unknown>> = {},
  options: { readonly exports?: readonly string[]; readonly format?: 'cjs' } = {},
): Record<string, unknown> {
  const names = Object.keys(scope).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const body = `${stripTypes(source, options.format)}\nreturn { ${(options.exports ?? []).join(', ')} };`;
  return new Function(...names, body)(...names.map((name) => scope[name])) as Record<string, unknown>;
}
