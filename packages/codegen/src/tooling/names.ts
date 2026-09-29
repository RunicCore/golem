/**
 * Identifier allocation shared by every generator. Generated bindings must be
 * valid in an ES module (always strict), and generated file names must stay
 * distinct on case-insensitive file systems.
 */

/**
 * ECMAScript reserved words plus the words reserved in strict mode and
 * modules, where generated code always runs.
 */
export const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield',
  'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static',
  'arguments', 'eval',
]);

/** Member names a schema field may not reuse. */
export const RESERVED_MODEL_MEMBERS: readonly string[] = Object.freeze([
  'constructor',
  'toJSON',
  'fromJSON',
  '$validator',
]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** PascalCase identifier derived from arbitrary source text. */
export function identifier(value: unknown, fallback = 'Value'): string {
  const words = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let result = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('') || fallback;
  if (!/^[A-Za-z_$]/.test(result)) result = `_${result}`;
  return result;
}

/** camelCase identifier derived from arbitrary source text. */
export function camelIdentifier(value: unknown, fallback = 'Value'): string {
  const pascal = identifier(value, fallback);
  return pascal[0].toLowerCase() + pascal.slice(1);
}

/** Object member key: bare when it is an identifier name, otherwise a string literal. */
export function propertyName(value: string): string {
  return IDENTIFIER.test(value) ? value : JSON.stringify(value);
}

/**
 * A value binding for `requested`. Reserved words (or a caller's wider
 * reserved set) receive a deterministic `_` suffix (`delete` becomes
 * `delete_`); callers report the rename.
 */
export function bindingName(requested: string, reserved: ReadonlySet<string> = RESERVED_BINDING_NAMES): string {
  let name = requested;
  while (reserved.has(name)) name = `${name}_`;
  return name;
}

/** Claims within one emitted namespace; a name may be claimed again only by the same origin. */
export class NameScope {
  private readonly claimed = new Map<string, string>();

  constructor(private readonly moduleName: string) {}

  claim(name: string, origin: string): void {
    const existing = this.claimed.get(name);
    if (existing !== undefined && existing !== origin) {
      throw new Error(
        `generated name collision for ${JSON.stringify(name)} in ${this.moduleName}: ${existing} and ${origin}`,
      );
    }
    this.claimed.set(name, origin);
  }

  rejectReserved(name: string, origin: string, reserved: ReadonlySet<string> | readonly string[], label: string): void {
    const set = reserved instanceof Set ? reserved : new Set(reserved);
    if (set.has(name)) {
      throw new Error(
        `generated name ${JSON.stringify(name)} from ${origin} collides with ${label} in ${this.moduleName}`,
      );
    }
  }

  has(name: string): boolean {
    return this.claimed.has(name);
  }
}

/** Reject generated paths that would overwrite each other on a case-insensitive file system. */
export function assertPortableFilenames(paths: Iterable<string>): void {
  const folded = new Map<string, string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const previous = folded.get(key);
    if (previous !== undefined && previous !== path) {
      throw new Error(
        `generated files ${JSON.stringify(previous)} and ${JSON.stringify(path)} differ only by letter case; rename one source name`,
      );
    }
    folded.set(key, path);
  }
}

/**
 * Check the public namespace of generator-owned, declaration-only templates.
 * This reads our emitted declarations, never arbitrary consumer TypeScript.
 */
export function assertUniquePublicExports(modules: ReadonlyMap<string, string>, entry = 'index.ts'): void {
  const scope = new NameScope(`public exports of ${entry}`);
  const seen = new Set<string>();
  const visit = (filename: string): void => {
    if (seen.has(filename)) return;
    seen.add(filename);
    const source = modules.get(filename);
    if (source === undefined) throw new Error(`Generated public module is missing: ${filename}`);
    for (const match of source.matchAll(/^export\s+(?:(?:declare|abstract)\s+)?(?:type|interface|class|const|let|var|enum|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      scope.claim(match[1], `${filename} export ${match[1]}`);
    }
    for (const match of source.matchAll(/^export\s+(?:type\s+)?\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s+['"]\.\/([^'"]+)['"]/gm)) {
      if (match[1]) scope.claim(match[1], `${filename} namespace ${match[1]}`);
      else visit(match[2].replace(/\.js$/, '.ts'));
    }
  };
  visit(entry);
}
