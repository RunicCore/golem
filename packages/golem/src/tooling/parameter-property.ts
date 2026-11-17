import type * as ts from './typescript-ns.js';

/**
 * Whether `parameter` is a parameter property: a constructor parameter with an accessibility, `override` or `readonly` modifier, which declares a
 * field of the class beside the parameter. `compiler` is the TypeScript that the caller loaded, so a host that loads it lazily can call this.
 */
export function isParameterProperty(compiler: typeof ts, parameter: ts.ParameterDeclaration): boolean {
  const { SyntaxKind } = compiler;
  const kinds = [SyntaxKind.PublicKeyword, SyntaxKind.PrivateKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.OverrideKeyword, SyntaxKind.ReadonlyKeyword];
  return (compiler.getModifiers(parameter) ?? []).some(modifier => kinds.includes(modifier.kind));
}
