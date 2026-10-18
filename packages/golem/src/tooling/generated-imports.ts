/** Blank comments and quoted strings, keeping line breaks, so a name that only a comment or a string mentions is not a use. */
function generatedCodeWithoutLiterals(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (literal) => literal.replace(/[^\n]/g, ' '),
  );
}

/** One import statement, with the rest of its last line. Only a name list in braces may span lines. */
const IMPORT_STATEMENT = /^import\s(?:[^;{\n]|\{[^}]*\})*;[^\n]*(?:\n|$)/gm;
const NAMED_IMPORT = /^(import\s+)(type\s+)?\{([^}]*)\}(\s+from\s+[^;]+;)([^\n]*\n?)$/;
const NAMESPACE_IMPORT = /^import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+[^;]+;/;

/**
 * Drop the imported names that generated code never uses, and the import statement when none is left.
 * A name that only a comment or a string mentions is unused. It writes a named import on one line.
 * Side-effect imports and imports with an empty name list stay: they keep a module in the program on purpose,
 * such as a sibling companion that registers its codecs. Default imports stay too.
 */
export function pruneGeneratedImports(source: string): string {
  const used = new Set(generatedCodeWithoutLiterals(source.replace(IMPORT_STATEMENT, '')).match(/[\w$]+/g));
  return source.replace(IMPORT_STATEMENT, (statement) => {
    const named = NAMED_IMPORT.exec(statement);
    if (named) {
      const [, prefix, typeOnly, contents, suffix, rest] = named;
      const imported = (contents ?? '').split(',').map((specifier) => specifier.trim()).filter(Boolean);
      if (imported.length === 0) return statement;
      const retained = imported.filter((specifier) => {
        // `type A as B` binds B.
        const localName = specifier.replace(/^type\s+/, '').split(/\s+as\s+/).at(-1);
        return localName !== undefined && used.has(localName);
      });
      return retained.length > 0 ? `${prefix}${typeOnly ?? ''}{ ${retained.join(', ')} }${suffix}${rest}` : '';
    }
    const namespace = NAMESPACE_IMPORT.exec(statement);
    if (namespace) return used.has(namespace[1] ?? '') ? statement : '';
    return statement;
  });
}
