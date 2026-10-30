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

/**
 * A stand-in for any module a generated file imports: every property read, call and construct on it gives the same stand-in again.
 * A name in `known` gives its own value instead, so a test sees the one call it asks about.
 */
export function openScope(known: Readonly<Record<string, unknown>> = {}): unknown {
  const open: unknown = new Proxy(function stub() {}, { get: () => open, apply: () => open, construct: () => open as object });
  return new Proxy(open as object, { get: (_target, name) => (typeof name === 'string' && Object.hasOwn(known, name) ? known[name] : open) });
}

/** The values a generated TypeScript module exports, with every import stubbed. */
export function exportsOf(source: string): Record<string, unknown> {
  const open = openScope();
  const holder = { exports: {} as Record<string, unknown> };
  runModule(source, { require: () => open, exports: holder.exports, module: holder }, { format: 'cjs' });
  return holder.exports;
}
