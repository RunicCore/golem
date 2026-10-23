/**
 * Code values. An emitter returns a `Code`, an ordered list of parts, and `render` is the one function that turns
 * parts into text. Runtime names, helpers, file-level names and the expression a piece reads are parts, so the imports
 * and the helpers of a file come from the parts and no step reads emitted text back to decide something.
 * Internal to the tooling: no package export names this module.
 */
import { compareText } from './generator-api.js';
import { RUNTIME_MODULE_RANK, type RuntimeModule } from './rt.js';

/** A name the file decides. The slot is its identity: two slots with one label are two names. */
export interface NameSlot { readonly label: string }

/**
 * How a read expression composes into larger code, which only the code that builds the read knows: a bare `name`, a `chain`
 * of property and index reads (`value["a"]`), or `other` (a call, a cast, a parenthesized expression). A piece that puts
 * its input before `as` or `.` wraps it in parentheses unless it is a name or a chain.
 */
export type ReadShape = 'name' | 'chain' | 'other';

/** The expression a code piece reads. The caller of the piece binds it. */
export interface InputSlot {
  readonly label: string;
  readonly shape: ReadShape;
  /** The input is an object whose properties the piece reads, such as a root `value`, so a property read needs no cast. */
  readonly record: boolean;
}

/**
 * A function that a file holds once, because code calls it. The definition may name other helpers, and may name this
 * helper: it is a function, so a helper that calls itself or another helper that calls it back is possible.
 */
export interface Helper {
  readonly id: string;
  readonly define: () => Code;
  /** Where the helper stands among helpers that no definition orders: lower first, then by id. A file with a fixed order of helpers sets it. */
  readonly rank?: number;
}

export type Part =
  /** `identifier` marks the text as one name that `identifier` checked, so a conversion that calls it on its value is a call of a function name (`calleeOf`). */
  | { readonly kind: 'text'; readonly text: string; readonly identifier?: true }
  | { readonly kind: 'runtime'; readonly module: RuntimeModule; readonly name: string; readonly typeOnly?: true; readonly alias?: string }
  | { readonly kind: 'imported'; readonly source: ImportSource; readonly name: string; readonly typeOnly?: true; readonly alias?: string }
  | { readonly kind: 'helper'; readonly helper: Helper }
  | { readonly kind: 'name'; readonly slot: NameSlot }
  | { readonly kind: 'input'; readonly slot: InputSlot };

/**
 * A module that a file imports names from, other than a runtime module: a companion, a handwritten class, a generated
 * validators module. The file declares each name in the order its import statement lists it; the name is imported only if
 * the code holds its part, so the import holds exactly the names the code uses.
 */
export class ImportSource {
  readonly #declared = new Map<string, Code>();

  /** `typeStatement` writes `import type { … }`, for a module that is imported for types only. */
  public constructor(public readonly specifier: string, public readonly typeStatement: boolean = false) {}

  /** The Code of `name`, which the code writes as `alias` when it has one. The first call of a name decides its place in the statement. */
  public name(name: string, options: { readonly alias?: string; readonly typeOnly?: true } = {}): Code {
    const key = `${name}\0${options.alias ?? ''}\0${options.typeOnly === true}`;
    let declared = this.#declared.get(key);
    if (!declared) {
      checkedIdentifier(name, 'imported name');
      if (options.alias !== undefined) checkedIdentifier(options.alias, 'alias');
      declared = fromParts([{ kind: 'imported', source: this, name, ...(options.typeOnly ? { typeOnly: true as const } : {}), ...(options.alias === undefined ? {} : { alias: options.alias }) }]);
      this.#declared.set(key, declared);
    }
    return declared;
  }

  /** The declared names that `used` holds, in the order of their declaration. */
  public statement(used: ReadonlySet<Code>): readonly Part[] {
    return [...this.#declared.values()].filter((declared) => used.has(declared)).map((declared) => declared.parts[0]);
  }
}

export interface Code {
  readonly parts: readonly Part[];
  /** The code is one object literal, which an arrow body wraps in parentheses. Only `asObjectLiteral` sets it, on the code the emitter built as that literal. */
  readonly objectLiteral?: true;
}

/** Every Code is a `CodeValue`. A Code in a string template would print "[object Object]", so its text conversion fails. */
class CodeValue implements Code {
  public readonly objectLiteral?: true;

  public constructor(public readonly parts: readonly Part[], objectLiteral: boolean = false) {
    if (objectLiteral) this.objectLiteral = true;
  }

  public toString(): never {
    throw new TypeError('a Code was put in a string template or a string; put it in the code tag, or in render');
  }
}

/** The Code of one runtime part: the value `name` of a runtime module, or its type when `typeOnly`. The rt tables make these. */
export function runtimeCode(module: RuntimeModule, name: string, typeOnly: boolean = false): Code {
  return new CodeValue([{ kind: 'runtime', module, name, ...(typeOnly ? { typeOnly: true } : {}) }]);
}

/** The runtime part `named` under a local name of the file: `rtType.serde.SerdeOptions` as `__GolemSerdeOptions` imports `SerdeOptions as __GolemSerdeOptions` and writes the alias. */
export function aliased(named: Code, alias: string): Code {
  const [only, ...more] = named.parts;
  if (only?.kind !== 'runtime' || more.length > 0) throw new TypeError('aliased takes the Code of one runtime part');
  return new CodeValue([{ ...only, alias: checkedIdentifier(alias, 'alias') }]);
}

/** A value that `literal` writes as a JSON literal. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function checkedIdentifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) throw new TypeError(`${what} must be an identifier, got ${JSON.stringify(name)}`);
  return name;
}

/** Build a Code from parts. Adjacent text parts become one, so equal code has one shape. */
function fromParts(parts: readonly Part[]): Code {
  const merged: Part[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (part.kind === 'text') {
      if (part.text === '') continue;
      if (last?.kind === 'text' && !last.identifier && !part.identifier) merged[merged.length - 1] = { kind: 'text', text: last.text + part.text };
      else merged.push(part);
    } else merged.push(part);
  }
  return new CodeValue(merged);
}

/**
 * The code tag. The text between the values is code that the emitter wrote. A value accepts Code only: a string is a type
 * error, so text enters through `literal`, `identifier` and this tag's own text, and nowhere else.
 */
export function code(strings: TemplateStringsArray, ...values: readonly Code[]): Code {
  const parts: Part[] = [];
  strings.forEach((text, index) => {
    parts.push({ kind: 'text', text });
    const value = values[index];
    if (value) parts.push(...value.parts);
  });
  return fromParts(parts);
}

/** Code from the pieces of a list, with `separator` between them. */
export function join(pieces: readonly Code[], separator: Code = fromParts([])): Code {
  const parts: Part[] = [];
  pieces.forEach((piece, index) => {
    if (index > 0) parts.push(...separator.parts);
    parts.push(...piece.parts);
  });
  return fromParts(parts);
}

/** A JSON literal of a value, such as a quoted string. */
export function literal(value: JsonValue): Code {
  return fromParts([{ kind: 'text', text: jsonText(value) }]);
}

function jsonText(value: JsonValue): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`literal cannot write ${value}`);
  return JSON.stringify(value);
}

/** A name that is written as it is, after a check that it is an identifier. */
export function identifier(name: string): Code {
  return fromParts([{ kind: 'text', text: checkedIdentifier(name, 'identifier'), identifier: true }]);
}

/**
 * Text that an emitter has not moved to Code yet. The migration needs it; the last step deletes it. It is the only door
 * through which a string of code becomes a Code.
 */
export function legacyText(text: string): Code {
  return fromParts([{ kind: 'text', text }]);
}

/** The code of an object literal, as the emitter that built the literal says. Any later change of the code drops the mark. */
export function asObjectLiteral(literalCode: Code): Code {
  return new CodeValue(literalCode.parts, true);
}

export function helper(id: string, define: () => Code, rank?: number): Helper {
  return { id: checkedIdentifier(id, 'helper id'), define, ...(rank === undefined ? {} : { rank }) };
}

/** A call site of a helper: the name of the helper, and a request that the file holds its definition. */
export function helperName(target: Helper): Code {
  return fromParts([{ kind: 'helper', helper: target }]);
}

export function nameSlot(label: string): NameSlot {
  return { label };
}

export function nameOf(slot: NameSlot): Code {
  return fromParts([{ kind: 'name', slot }]);
}

export function inputSlot(label: string, shape: ReadShape = 'other', record: boolean = false): InputSlot {
  return { label, shape, record };
}

/** A block comment. The text cannot end the comment. */
export function blockComment(text: string): Code {
  if (text.includes('*/')) throw new TypeError(`a comment cannot hold "*/", got ${JSON.stringify(text)}`);
  return fromParts([{ kind: 'text', text: `/* ${text} */` }]);
}

/** The code without the whitespace at its end. Whitespace names nothing. */
export function trimEnd(root: Code): Code {
  const parts = [...root.parts];
  for (let last = parts.at(-1); last?.kind === 'text'; last = parts.at(-1)) {
    parts.pop();
    const kept = last.text.trimEnd();
    if (kept !== '') { parts.push({ kind: 'text', text: kept }); break; }
  }
  return fromParts(parts);
}

/** Spaces at the start of a line. Whitespace names nothing, so it is the one text that needs no check. */
export function indentation(spaces: number): Code {
  return fromParts([{ kind: 'text', text: ' '.repeat(spaces) }]);
}

/** Code that an emitter wrote, or the text of a walker that does not return Code yet. */
export type Emitted = string | Code;

/** A string is wrapped as one text part. */
// migration door, deleted in steps 6 and 7 (T-289, and P-22 step 7): the reads that the walkers of golem-model and golem-openapi give as text, the item callbacks of sequence-conversion, and the line writer of the validator compiler still give strings
export function emittedCode(emitted: Emitted): Code {
  return typeof emitted === 'string' ? legacyText(emitted) : emitted;
}

const NAME_TEXT = /^[A-Za-z_$][\w$]*$/;
const CHAIN_TEXT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:\d+|"[^"\\]*"|'[^'\\]*')\])*$/;

/**
 * The shape of an expression. An input part has the shape its slot was made with, so a piece never reads its text. Text
 * from a walker that does not give a slot is tested, and any other code is `other`.
 */
export function readShape(expression: Emitted): ReadShape {
  const [only, ...more] = emittedCode(expression).parts;
  if (only === undefined || more.length > 0) return 'other';
  if (only.kind === 'input') return only.slot.shape;
  if (only.kind === 'name' || only.kind === 'imported') return 'name';
  // migration door, deleted in steps 6 and 7 (T-289, and P-22 step 7): tests the text of a read that a caller wrote as a string
  if (only.kind === 'text') return NAME_TEXT.test(only.text) ? 'name' : CHAIN_TEXT.test(only.text) ? 'chain' : 'other';
  return 'other';
}

export function inputOf(slot: InputSlot): Code {
  return fromParts([{ kind: 'input', slot }]);
}

/** How many times a piece reads the input `slot`: the number of its input parts for that slot. */
export function inputCount(root: Code, slot: InputSlot): number {
  return root.parts.filter((part) => part.kind === 'input' && part.slot === slot).length;
}

/** The piece with each input part of `slot` replaced by `value`. */
export function bindInput(root: Code, slot: InputSlot, value: Code): Code {
  return fromParts(root.parts.flatMap((part) => (part.kind === 'input' && part.slot === slot ? value.parts : [part])));
}

/** The result of `bindRead`: the bound piece, and whether it reads the local. */
export interface BoundRead {
  readonly code: Code;
  readonly local: boolean;
}

/**
 * Bind the input of a piece the way its caller needs. A piece that reads its input more than once, counting the
 * `otherReads` the caller adds around it, reads the `local` that the caller sets to `read`; any other piece reads `read`.
 */
export function bindRead(piece: Code, slot: InputSlot, read: Code, local: Code, otherReads: number = 0): BoundRead {
  const repeated = inputCount(piece, slot) + otherReads > 1;
  return { code: bindInput(piece, slot, repeated ? local : read), local: repeated };
}

/** The names a file decided, by slot. A file builds it before it writes the bodies. */
export class NameTable {
  readonly #names = new Map<NameSlot, string>();
  readonly #taken = new Map<string, NameSlot>();

  /** Decide the name of a slot. A name belongs to one slot, and a slot has one name. */
  declare(slot: NameSlot, name: string): void {
    checkedIdentifier(name, `name of "${slot.label}"`);
    const holder = this.#taken.get(name);
    if (holder && holder !== slot) throw new Error(`name "${name}" is taken by "${holder.label}" and cannot also name "${slot.label}"`);
    const known = this.#names.get(slot);
    if (known !== undefined && known !== name) throw new Error(`"${slot.label}" is already named "${known}", not "${name}"`);
    this.#names.set(slot, name);
    this.#taken.set(name, slot);
  }

  resolve(slot: NameSlot): string {
    const name = this.#names.get(slot);
    if (name === undefined) throw new Error(`no name is decided for "${slot.label}"`);
    return name;
  }
}

/** What a Code needs from the runtime and from the file: the runtime parts grouped by module, and the helpers with their code. */
interface RuntimeNames {
  readonly values: Map<string, ImportedName>;
  readonly types: Map<string, ImportedName>;
}

/** A name a file imports from a runtime module, and the local name it binds when that differs. */
interface ImportedName { readonly name: string; readonly alias?: string }

interface Collected {
  readonly runtime: Map<RuntimeModule, RuntimeNames>;
  /** The imported parts of each source, by the Code that `ImportSource.name` made. */
  readonly imported: Map<ImportSource, Set<Code>>;
  /** The helpers by id, in the order a file can define them: a helper comes after the helpers its definition names. */
  readonly helpers: Map<string, { readonly helper: Helper; readonly definition: Code }>;
}

/** Helpers with a rank come first by rank, then every helper by id in code point order. */
function compareHelpers(left: Helper, right: Helper): number {
  return (left.rank ?? Infinity) === (right.rank ?? Infinity) ? compareText(left.id, right.id) : (left.rank ?? Infinity) < (right.rank ?? Infinity) ? -1 : 1;
}

function collect(root: Code): Collected {
  const runtime = new Map<RuntimeModule, RuntimeNames>();
  const imported = new Map<ImportSource, Set<Code>>();
  const found = new Map<string, { readonly helper: Helper; readonly definition: Code; readonly needs: readonly Helper[] }>();
  const scan = (piece: Code): readonly Helper[] => {
    const needs = new Map<string, Helper>();
    for (const part of piece.parts) {
      if (part.kind === 'runtime') {
        const names = runtime.get(part.module) ?? { values: new Map<string, ImportedName>(), types: new Map<string, ImportedName>() };
        (part.typeOnly ? names.types : names.values).set(`${part.name}\0${part.alias ?? ''}`, { name: part.name, ...(part.alias === undefined ? {} : { alias: part.alias }) });
        runtime.set(part.module, names);
      } else if (part.kind === 'imported') {
        const used = imported.get(part.source) ?? new Set<Code>();
        used.add(part.source.name(part.name, { ...(part.alias === undefined ? {} : { alias: part.alias }), ...(part.typeOnly ? { typeOnly: true as const } : {}) }));
        imported.set(part.source, used);
      } else if (part.kind === 'helper') {
        needs.set(part.helper.id, part.helper);
      }
    }
    return [...needs.values()].sort(compareHelpers);
  };
  const pending: Helper[] = [...scan(root)];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const known = found.get(next.id);
    if (known) {
      if (known.helper !== next) throw new Error(`two helpers are named "${next.id}"`);
      continue;
    }
    const definition = next.define();
    const needs = scan(definition);
    found.set(next.id, { helper: next, definition, needs });
    pending.push(...needs);
  }
  // A helper that a file reads while it loads, such as a constant, must come after the helpers its definition names.
  // The order is the post-order of the names, each level in code point order of the ids. A cycle is functions only.
  const helpers = new Map<string, { readonly helper: Helper; readonly definition: Code }>();
  const visiting = new Set<string>();
  const visit = (next: Helper): void => {
    if (helpers.has(next.id) || visiting.has(next.id)) return;
    visiting.add(next.id);
    const entry = found.get(next.id);
    if (!entry) return;
    entry.needs.forEach(visit);
    helpers.set(next.id, { helper: entry.helper, definition: entry.definition });
  };
  [...found.values()].map(({ helper: each }) => each).sort(compareHelpers).forEach(visit);
  return { runtime, imported, helpers };
}

export interface RuntimeImport {
  readonly module: RuntimeModule;
  /** Each value name once, as `name` or `name as alias`, in the order of the file (see `ImportOptions.order`). */
  readonly names: readonly string[];
  /** Each type name once, written the same way. */
  readonly types: readonly string[];
}

/** The names of a module in the order of a file: the names its `order` lists come first in that order, then the others in code point order. */
function inOrder(names: ReadonlyMap<string, ImportedName>, listed: readonly string[] = []): readonly string[] {
  const place = (name: string): number => { const at = listed.indexOf(name); return at < 0 ? Infinity : at; };
  return [...names.values()]
    .sort((left, right) => place(left.name) === place(right.name) ? compareText(left.name, right.name) || compareText(left.alias ?? '', right.alias ?? '') : place(left.name) < place(right.name) ? -1 : 1)
    .map(({ name, alias }) => alias === undefined ? name : `${name} as ${alias}`);
}

/** The runtime parts of a Code and of the helpers it needs, grouped by module in the fixed module order. */
export function importSet(root: Code, options: Pick<ImportOptions, 'order' | 'modules'> = {}): readonly RuntimeImport[] {
  const { order = {}, modules } = options;
  const position = (module: RuntimeModule): number => modules ? modules.indexOf(module) : RUNTIME_MODULE_RANK[module];
  const found = [...collect(root).runtime];
  const unlisted = found.find(([module]) => position(module) < 0);
  if (unlisted) throw new Error(`the code uses the runtime module "${unlisted[0]}", which the file does not list in its module order`);
  return found
    .sort(([left], [right]) => position(left) - position(right))
    .map(([module, { values, types }]) => ({ module, names: inOrder(values, order[module]), types: inOrder(types, order[module]) }));
}

/** How a file writes the imports of its runtime parts. */
export interface ImportOptions {
  /** The specifier of a runtime module; a module not listed is imported from `@exprtlabs/golem/<module>`. */
  readonly specifiers?: Partial<Readonly<Record<RuntimeModule, string>>>;
  /** The quote of a specifier; a single quote by default. */
  readonly quote?: "'" | '"';
  /**
   * How a module writes its type names: `separate` (the default) puts them in an `import type` statement before the value
   * statement; `inline` puts them after the values in one statement, each as `type Name`; `ordered` puts values and
   * types in one statement in the order of `order`, then the unlisted values, then the unlisted types.
   */
  readonly typeNames?: 'separate' | 'inline' | 'ordered';
  /** The names of a module that a file with a fixed order lists: they come first, in this order, for values and types alike; the others follow in code point order. */
  /** The runtime modules this call writes, in this order; a module that the code uses and the list lacks is an error. Without it, every module in the fixed order. */
  readonly modules?: readonly RuntimeModule[];
  readonly order?: Partial<Readonly<Record<RuntimeModule, readonly string[]>>>;
}

/**
 * The import statements of the runtime parts, in module order. A type name is never in a value import: it goes in an
 * `import type` statement before the value statement, or after the values as `type Name` when the file asks for `inline`.
 */
export function runtimeImports(root: Code, options: ImportOptions = {}): readonly Code[] {
  return importSet(root, options).flatMap((entry) => importLines(entry, options));
}

/** The statements of one module of the import set (see `runtimeImports`), for a file that puts other statements between modules. */
export function importLines({ module, names, types }: RuntimeImport, options: ImportOptions = {}): readonly Code[] {
  const specifier = options.specifiers?.[module] ?? `@exprtlabs/golem/${module}`;
  const quoted = options.quote === '"' ? jsonText(specifier) : `'${checkedSingleQuoted(specifier)}'`;
  if (options.typeNames === 'inline') {
    const listed = [...names, ...types.map((type) => `type ${type}`)];
    return listed.length > 0 ? [plainText(`import { ${listed.join(', ')} } from ${quoted};`)] : [];
  }
  if (options.typeNames === 'ordered') {
    const listed = options.order?.[module] ?? [];
    const place = (spelled: string): number => { const at = listed.indexOf(spelled.split(' as ')[0] ?? spelled); return at < 0 ? Infinity : at; };
    const members = [...names.map((spelled) => ({ spelled, typeOnly: false })), ...types.map((spelled) => ({ spelled: `type ${spelled}`, typeOnly: true }))];
    const ordered = members
      .map((member, index) => ({ member, index, at: place(member.typeOnly ? member.spelled.slice('type '.length) : member.spelled) }))
      .sort((left, right) => left.at === right.at ? left.index - right.index : left.at < right.at ? -1 : 1)
      .map(({ member }) => member.spelled);
    return ordered.length > 0 ? [plainText(`import { ${ordered.join(', ')} } from ${quoted};`)] : [];
  }
  return [
    ...(types.length > 0 ? [plainText(`import type { ${types.join(', ')} } from ${quoted};`)] : []),
    ...(names.length > 0 ? [plainText(`import { ${names.join(', ')} } from ${quoted};`)] : []),
  ];
}

/**
 * The import statements of the names that code takes from `sources`, one statement per source, in the order of `sources`.
 * A source with no used name writes none. Code that holds a name of a source that neither `sources` nor `elsewhere` (the
 * sources the file writes in another call) lists is an error.
 */
export function fileImports(
  root: Code,
  sources: readonly ImportSource[],
  options: Pick<ImportOptions, 'quote'> & { readonly elsewhere?: readonly ImportSource[] } = {},
): readonly Code[] {
  const { imported } = collect(root);
  const unlisted = [...imported.keys()].find((source) => !sources.includes(source) && !options.elsewhere?.includes(source));
  if (unlisted) throw new Error(`the code uses names of "${unlisted.specifier}", which the file does not list among its import sources`);
  return sources.flatMap((source) => {
    const used = imported.get(source);
    if (!used) return [];
    const quoted = options.quote === '"' ? jsonText(source.specifier) : `'${checkedSingleQuoted(source.specifier)}'`;
    const names = source.statement(used).map((part) => {
      if (part.kind !== 'imported') throw new Error('an import source declared a part that is not a name');
      const spelled = part.alias === undefined ? part.name : `${part.name} as ${part.alias}`;
      return part.typeOnly && !source.typeStatement ? `type ${spelled}` : spelled;
    });
    return [plainText(`import ${source.typeStatement ? 'type ' : ''}{ ${names.join(', ')} } from ${quoted};`)];
  });
}

/** The names of `source` that the code uses, as the module exports them, in the order of the declaration. */
export function importedNames(root: Code, source: ImportSource): readonly string[] {
  const used = collect(root).imported.get(source);
  return used ? source.statement(used).flatMap((part) => part.kind === 'imported' ? [part.name] : []) : [];
}

function checkedSingleQuoted(specifier: string): string {
  if (/['\\\n]/.test(specifier)) throw new TypeError(`a module specifier written in single quotes cannot hold a quote, a backslash or a line end, got ${JSON.stringify(specifier)}`);
  return specifier;
}

/** The helpers that a Code names, and the helpers that those helpers name, in the order of their definitions (see `collect`). */
export function helperSet(root: Code): readonly Helper[] {
  return [...collect(root).helpers.values()].map(({ helper: found }) => found);
}

/** The definitions of `helperSet`, one Code for each helper. */
export function helperDefinitions(root: Code): readonly Code[] {
  return [...collect(root).helpers.values()].map(({ definition }) => definition);
}

/** Text that this module writes itself: import lines and the gap between helpers. */
function plainText(text: string): Code {
  return fromParts([{ kind: 'text', text }]);
}

/**
 * Whether two Codes write the same code: their parts match one by one, and a runtime or helper part counts as the text of
 * its name, so `rt.serde.parseJson` equals the text `parseJson` that a caller wrote by hand.
 */
export function sameCode(left: Code, right: Code): boolean {
  const flat = (root: Code): readonly Part[] => fromParts(root.parts.map((part): Part =>
    part.kind === 'runtime' || part.kind === 'imported' ? { kind: 'text', text: part.alias ?? part.name }
      : part.kind === 'helper' ? { kind: 'text', text: part.helper.id }
        : part.kind === 'text' ? { kind: 'text', text: part.text }
          : part)).parts;
  const [first, second] = [flat(left), flat(right)];
  return first.length === second.length && first.every((part, index) => {
    const other = second[index];
    switch (part.kind) {
      case 'text': return other.kind === 'text' && other.text === part.text;
      case 'name': return other.kind === 'name' && other.slot === part.slot;
      case 'input': return other.kind === 'input' && other.slot === part.slot;
      default: return false;
    }
  });
}

/**
 * The one place that makes text. A runtime part is its export name and a helper part is its id. A name part reads the
 * table of the file. An input part must be bound before the Code is rendered.
 */
export function render(root: Code, names: NameTable = new NameTable()): string {
  let text = '';
  for (const part of root.parts) {
    switch (part.kind) {
      case 'text': text += part.text; break;
      case 'runtime':
      case 'imported': text += part.alias ?? part.name; break;
      case 'helper': text += part.helper.id; break;
      case 'name': text += names.resolve(part.slot); break;
      case 'input': throw new Error(`the input "${part.slot.label}" is not bound`);
    }
  }
  return text;
}
