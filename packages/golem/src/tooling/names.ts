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

/** The form of the locals of generated functions (`$v0`, `$k`): a `$`, one lowercase letter and digits. No name of a file may have it. */
const LOCAL_FORM = /^\$[a-z]\d*$/;

export function hasLocalForm(name: string): boolean {
  return LOCAL_FORM.test(name);
}

/** The RUNM1088 message for a name a user wrote that has the form of a local. */
export function localFormMessage(name: string, what: string): string {
  return `${what} is named "${name}", which has the form of a local of generated code (a $, one lowercase letter and digits). Generated code cannot import it under that name. Rename it.`;
}

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
  // A name of the file must not have the form of a local of generated code.
  return hasLocalForm(result) ? `${result}_` : result;
}

/** camelCase identifier derived from arbitrary source text. */
export function camelIdentifier(value: unknown, fallback = 'Value'): string {
  const pascal = identifier(value, fallback);
  return pascal[0].toLowerCase() + pascal.slice(1);
}

/**
 * A value binding for `requested`. Reserved words (or a caller's wider
 * reserved set) receive a deterministic `_` suffix (`delete` becomes
 * `delete_`); callers report the rename.
 */
export function bindingName(requested: string, reserved: ReadonlySet<string> = RESERVED_BINDING_NAMES): string {
  let name = requested;
  while (reserved.has(name) || hasLocalForm(name)) name = `${name}_`;
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

/** A generated module as the generator holds it: the names it exports, and the modules it re-exports whole (`export * from`). */
export interface PublicModule {
  readonly exports: readonly string[];
  readonly stars: readonly string[];
}

/**
 * Check the public namespace of generated modules from the export names the generator holds for each module, with no text
 * read. A name that two modules reachable from `entry` export is a collision. A module that the walk reaches and `modules`
 * lacks is an error.
 */
export function assertUniqueExportNames(modules: ReadonlyMap<string, PublicModule>, entry = 'index.ts'): void {
  const scope = new NameScope(`public exports of ${entry}`);
  const seen = new Set<string>();
  const visit = (filename: string): void => {
    if (seen.has(filename)) return;
    seen.add(filename);
    const module = modules.get(filename);
    if (module === undefined) throw new Error(`Generated public module is missing: ${filename}`);
    for (const name of module.exports) scope.claim(name, `${filename} export ${name}`);
    module.stars.forEach(visit);
  };
  visit(entry);
}
