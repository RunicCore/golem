import * as ts from './typescript-ns.js';

/** Resolve imported aliases without using the local spelling of a declaration. */
export function resolveSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  const seen = new Set<ts.Symbol>();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}
