/**
 * Code values. An emitter returns a `Code`, an ordered list of parts, and `render` is the one function that turns
 * parts into text. Runtime names, helpers, file-level names and the expression a piece reads are parts, so the imports
 * and the helpers of a file come from the parts and no step reads emitted text back to decide something.
 * Internal to the tooling: no package export names this module.
 */
import { compareText } from './generator-core.js';
import { hasLocalForm } from './names.js';
import { RUNTIME_MODULE_RANK, RUNTIME_SPECIFIER, runtimeTypeSpecifier, type RuntimeModule } from './rt.js';

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
  /** A file that names it defines it before its pieces (`placeHelpers`), so no piece lists it. */
  readonly selfPlaced?: true;
}

export type Part =
  /** `identifier` marks the text as one name that `identifier` checked, so a conversion that calls it on its value is a call of a function name (`calleeOf`). */
  | { readonly kind: 'text'; readonly text: string; readonly identifier?: true }
  | { readonly kind: 'runtime'; readonly module: RuntimeModule; readonly name: string; readonly typeOnly?: true; readonly alias?: string }
  | { readonly kind: 'imported'; readonly source: ImportSource; readonly name: string; readonly typeOnly?: true; readonly alias?: string }
  | { readonly kind: 'helper'; readonly helper: Helper }
  | { readonly kind: 'name'; readonly slot: NameSlot }
  /** A name that the file exports. It is written as the name; the exports of a file are the export parts of its Code. */
  | { readonly kind: 'export'; readonly name: string }
  | { readonly kind: 'input'; readonly slot: InputSlot }
  /** A line end. Render writes it with the indentation that the `indent` parts before it set. */
  | { readonly kind: 'line' }
  /** A change of the indentation, in spaces, for each `line` after it. `nest` writes the pair that opens and closes a level. */
  | { readonly kind: 'indent'; readonly by: number };

/**
 * A module that a file imports names from, other than a runtime module: a companion, a handwritten class, a generated
 * validators module. The file declares each name in the order its import statement lists it; the name is imported only if
 * the code holds its part, so the import holds exactly the names the code uses.
 */
export class ImportSource {
  readonly #declared = new Map<string, Code>();
  readonly #codeOf = new Map<Part, Code>();

  /**
   * `typeStatement` writes `import type { … }`, for a module that is imported for types only. `namespace` makes the
   * statement `import * as <name> from '…'` (`import type * as` for a type statement): the file binds the whole module under
   * that name, and `namespace()` is the part that uses it. `sorted` lists the used names in the order of their spelling
   * (`type Name` for a type name in a value statement), not in the order of their declaration, for a module that several
   * files import from with different names.
   */
  public readonly namespaceName: string | undefined;
  readonly #sorted: boolean;

  public constructor(public readonly specifier: string, public readonly typeStatement: boolean = false, options: { readonly namespace?: string; readonly sorted?: true } = {}) {
    if (options.namespace !== undefined) checkedIdentifier(options.namespace, 'namespace name');
    this.namespaceName = options.namespace;
    this.#sorted = options.sorted === true;
  }

  /** The Code of the local name of a namespace import. The statement is written only when the code holds it. */
  public namespace(): Code {
    if (this.namespaceName === undefined) throw new TypeError(`the import source "${this.specifier}" is not a namespace import`);
    return this.name(this.namespaceName);
  }

  /** The Code of `name`, which the code writes as `alias` when it has one. The first call of a name decides its place in the statement. */
  public name(name: string, options: { readonly alias?: string; readonly typeOnly?: true } = {}): Code {
    // A name with no alias and no type mark is its own key: an identifier holds no NUL.
    const key = options.alias === undefined && options.typeOnly !== true ? name : `${name}\0${options.alias ?? ''}\0${options.typeOnly === true}`;
    let declared = this.#declared.get(key);
    if (!declared) {
      // An aliased import binds the alias, so the exported name only has to be a name that a module can export.
      if (options.alias === undefined) checkedIdentifier(name, 'imported name');
      else syntaxChecked(name, 'imported name');
      if (options.alias !== undefined) checkedIdentifier(options.alias, 'alias');
      declared = fromParts([{ kind: 'imported', source: this, name, ...(options.typeOnly ? { typeOnly: true as const } : {}), ...(options.alias === undefined ? {} : { alias: options.alias }) }]);
      this.#declared.set(key, declared);
      this.#codeOf.set(declared.parts[0]!, declared);
    }
    return declared;
  }

  /** The Code that `name` made for one of its parts; a part that `name` did not make is declared now. */
  public declaredFor(part: Part): Code {
    if (part.kind !== 'imported') throw new Error('an import source declared a part that is not a name');
    return this.#codeOf.get(part) ?? this.name(part.name, { ...(part.alias === undefined ? {} : { alias: part.alias }), ...(part.typeOnly ? { typeOnly: true as const } : {}) });
  }

  /**
   * The declared names that `used` holds, in the order of their declaration, or of their spelling for a sorted source. A name
   * the code uses as a value and as a type is imported once, as the value.
   */
  public statement(used: ReadonlySet<Code>): readonly Part[] {
    const parts = [...this.#declared.values()].filter((declared) => used.has(declared)).map((declared) => declared.parts[0]);
    const values = new Set(parts.flatMap((part) => part.kind === 'imported' && !part.typeOnly ? [`${part.name}\0${part.alias ?? ''}`] : []));
    const kept = parts.filter((part) => !(part.kind === 'imported' && part.typeOnly && values.has(`${part.name}\0${part.alias ?? ''}`)));
    return this.#sorted ? kept.sort((left, right) => compareText(this.spelled(left), this.spelled(right))) : kept;
  }

  /** How the import statement writes a name: `name`, `name as alias`, and `type` before a type name of a value statement. */
  public spelled(part: Part): string {
    if (part.kind !== 'imported') throw new Error('an import source declared a part that is not a name');
    const spelled = part.alias === undefined ? part.name : `${part.name} as ${part.alias}`;
    return part.typeOnly && !this.typeStatement ? `type ${spelled}` : spelled;
  }
}

export interface Code {
  readonly parts: readonly Part[];
  /** The code is one object literal, which an arrow body wraps in parentheses. Only `asObjectLiteral` sets it, on the code the emitter built as that literal. */
  readonly objectLiteral?: true;
}

/**
 * Every Code is a `CodeValue`. A Code in a string template would print "[object Object]", so its text conversion fails.
 *
 * A Code made from other Codes (the code tag, `join`, `joinIndented`) holds them and writes no parts when it is built: the
 * parts of a piece that other pieces contain would be copied once for each level that contains it. `parts` writes them the
 * first time a step reads them, in one pass over the leaves, and a Code is never changed, so they are kept. The pass keeps
 * its own stack, so the depth of the nesting is not limited by the call stack.
 */
abstract class CodeValue implements Code {
  public readonly objectLiteral?: true;
  #parts: readonly Part[] | undefined;

  public constructor(objectLiteral: boolean = false) {
    if (objectLiteral) this.objectLiteral = true;
  }

  public get parts(): readonly Part[] {
    if (this.#parts === undefined) {
      const out: Part[] = [];
      let pending = '';
      walk(this, (text) => { pending += text; return false; }, (parts) => { pending = append(out, pending, parts); return false; });
      this.#parts = finishParts(out, pending);
    }
    return this.#parts;
  }

  /** The parts of this Code when they are written already, or `undefined` when a pass over its slots has to write them. */
  public ready(): readonly Part[] | undefined {
    return this.#parts;
  }

  /** Whether the code writes no part, which `parts.length === 0` also tells, but this reads no parts of a code that was not flattened. */
  public isEmpty(): boolean {
    if (this.#parts !== undefined) return this.#parts.length === 0;
    let empty = true;
    walk(this, () => { empty = false; return true; }, (parts) => { empty = !parts.some(writesSomething); return !empty; });
    return empty;
  }

  /** The number of slots: each is a text or a Code, and the slots in order write the code. */
  public abstract slotCount(): number;

  public abstract slot(index: number): string | Code | undefined;

  public toString(): never {
    throw new TypeError('a Code was put in a string template or a string; put it in the code tag, or in render');
  }
}

function writesSomething(part: Part): boolean {
  return part.kind !== 'text' || part.text !== '';
}

/**
 * Give `onText` the text and `onParts` the parts of the leaves of `root` in order, until one of them returns true. A leaf is
 * a text, a Code with its parts written, or a Code that holds its parts. The walk keeps a stack of the slots still to read.
 */
function walk(root: CodeValue, onText: (text: string) => boolean, onParts: (parts: readonly Part[]) => boolean): void {
  const nodes: CodeValue[] = [root];
  const next: number[] = [0];
  while (nodes.length > 0) {
    const top = nodes.length - 1;
    const node = nodes[top]!;
    const index = next[top]!;
    if (index >= node.slotCount()) {
      nodes.pop();
      next.pop();
      continue;
    }
    next[top] = index + 1;
    const item = node.slot(index);
    if (typeof item === 'string') {
      if (item !== '' && onText(item)) return;
    } else if (item instanceof CodeValue) {
      const ready = item.ready();
      if (ready === undefined) {
        nodes.push(item);
        next.push(0);
      } else if (onParts(ready)) return;
    } else if (item && onParts(item.parts)) return;
  }
}

/** A Code that holds its parts, which are written already: adjacent text is one text. */
class PartsCode extends CodeValue {
  public constructor(private readonly held: readonly Part[], objectLiteral: boolean = false) {
    super(objectLiteral);
  }

  public override get parts(): readonly Part[] {
    return this.held;
  }

  public override ready(): readonly Part[] {
    return this.held;
  }

  public override isEmpty(): boolean {
    return !this.held.some(writesSomething);
  }

  public slotCount(): number {
    return 0;
  }

  public slot(): undefined {
    return undefined;
  }
}

/** The text between the values of a code tag, and the values: the slots are text, value, text, value, ..., text. */
class TagCode extends CodeValue {
  public constructor(private readonly strings: readonly string[], private readonly values: readonly Code[], objectLiteral: boolean = false) {
    super(objectLiteral);
  }

  public slotCount(): number {
    return this.values.length * 2 + 1;
  }

  public slot(index: number): string | Code | undefined {
    return index % 2 === 0 ? this.strings[index / 2] : this.values[(index - 1) / 2];
  }
}

/** The pieces of a `join`, and the separator between them: the slots are piece, separator, piece, ..., piece. */
class JoinCode extends CodeValue {
  public constructor(private readonly pieces: readonly Code[], private readonly separator: Code) {
    super();
  }

  public slotCount(): number {
    return Math.max(0, this.pieces.length * 2 - 1);
  }

  public slot(index: number): Code | undefined {
    return index % 2 === 0 ? this.pieces[index / 2] : this.separator;
  }
}

/** The lines of a `joinIndented`, and the separator between them: the slots of each line are its separator (not the first line's), its spaces and its body. */
class LinesCode extends CodeValue {
  public constructor(private readonly lines: readonly IndentedLine[], private readonly separator: Code) {
    super();
  }

  public slotCount(): number {
    return this.lines.length * 3;
  }

  public slot(index: number): string | Code | undefined {
    const line = Math.floor(index / 3);
    switch (index % 3) {
      case 0: return line > 0 ? this.separator : undefined;
      case 1: return ' '.repeat(this.lines[line]!.spaces);
      default: return this.lines[line]!.body;
    }
  }
}

/** Whether `piece` writes nothing, as `piece.parts.length === 0` says. It does not write the parts of a piece that holds other pieces. */
export function isEmpty(piece: Code): boolean {
  return piece instanceof CodeValue ? piece.isEmpty() : piece.parts.length === 0;
}

/** The Code of one runtime part: the value `name` of a runtime module, or its type when `typeOnly`. The rt tables make these. */
export function runtimeCode(module: RuntimeModule, name: string, typeOnly: boolean = false): Code {
  return new PartsCode([{ kind: 'runtime', module, name, ...(typeOnly ? { typeOnly: true } : {}) }]);
}

/** The runtime part `named` under a local name of the file: `rtType.serde.SerdeOptions` as `__GolemSerdeOptions` imports `SerdeOptions as __GolemSerdeOptions` and writes the alias. */
export function aliased(named: Code, alias: string): Code {
  const [only, ...more] = named.parts;
  if (only?.kind !== 'runtime' || more.length > 0) throw new TypeError('aliased takes the Code of one runtime part');
  return new PartsCode([{ ...only, alias: checkedIdentifier(alias, 'alias') }]);
}

/** A value that `literal` writes as a JSON literal. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A bare object key: ASCII only, so the same name stays a string literal key in every emitted file. */
const PROPERTY_NAME = /^[A-Za-z_$][\w$]*$/;
/** An identifier of the language: a name a user writes in a model file can hold any Unicode letter. */
const IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*$/u;

/**
 * The locals of generated functions: `$`, one letter for the kind, and an index (`$v0`, `$p1`, `$k`). `localCode` is the
 * one allocator and the only way to write such a name as a binding. Every other name passes `checkedIdentifier`, which
 * refuses this form (a property key, `propertyKey`, is not a binding and may have it). So a local cannot equal a
 * parameter, an import, a helper, a class or any other name of the file. A function keeps its locals apart by giving each
 * kind its own letter and each local of a kind its own index.
 */
const LOCAL_LETTERS = {
  value: 'v',
  piece: 'p',
  field: 'f',
  present: 'e',
  wire: 'w',
  key: 'k',
  extra: 'x',
  record: 'r',
  inlineField: 'i',
  tag: 't',
  projected: 'j',
  index: 'n',
  union: 'u',
  source: 's',
} as const;
export type LocalKind = keyof typeof LOCAL_LETTERS;

/** The local of `kind` with `index`; a kind that a function holds once takes no index. */
export function localCode(kind: LocalKind, index?: number): Code {
  const letter = Object.hasOwn(LOCAL_LETTERS, kind) ? LOCAL_LETTERS[kind] : undefined;
  if (letter === undefined || (index !== undefined && !Number.isSafeInteger(index))) {
    throw new TypeError(`a local needs one of the kinds ${Object.keys(LOCAL_LETTERS).join(', ')} and an integer index, got ${JSON.stringify([kind, index])}`);
  }
  return fromParts([{ kind: 'text', text: `$${letter}${index ?? ''}`, identifier: true }]);
}

function syntaxChecked(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) throw new TypeError(`${what} must be an identifier, got ${JSON.stringify(name)}`);
  return name;
}

function checkedIdentifier(name: string, what: string): string {
  syntaxChecked(name, what);
  if (hasLocalForm(name)) throw new TypeError(`${what} ${JSON.stringify(name)} has the form of a local of generated code (a $, one lowercase letter and digits); rename it`);
  return name;
}

/**
 * Append `source` to `out`. Adjacent text parts become one, so equal code has one shape: a run of text is held in `pending`
 * until a part that is not mergeable text arrives, so a run of any length makes one part. A checked identifier stays its own
 * part. It returns the text still pending; `finish` writes it.
 */
function append(out: Part[], pending: string, source: readonly Part[]): string {
  for (let index = 0; index < source.length; index += 1) {
    const part = source[index]!;
    if (part.kind === 'text' && !part.identifier) pending += part.text;
    else {
      if (pending !== '') { out.push({ kind: 'text', text: pending }); pending = ''; }
      out.push(part);
    }
  }
  return pending;
}

function finishParts(out: Part[], pending: string): readonly Part[] {
  if (pending !== '') out.push({ kind: 'text', text: pending });
  return out;
}

function finish(out: Part[], pending: string): Code {
  return new PartsCode(finishParts(out, pending));
}

/** Build a Code from parts. Adjacent text parts become one, so equal code has one shape. */
function fromParts(parts: readonly Part[]): Code {
  // One part needs no merge, unless it is empty text, which is no part.
  if (parts.length === 1) {
    const only = parts[0]!;
    if (only.kind !== 'text' || only.text !== '') return new PartsCode(parts);
  }
  const out: Part[] = [];
  return finish(out, append(out, '', parts));
}

/**
 * The code tag. The text between the values is code that the emitter wrote. A value accepts Code only: a string is a type
 * error, so text enters through `literal`, `identifier` and this tag's own text, and nowhere else.
 */
export function code(strings: TemplateStringsArray, ...values: readonly Code[]): Code {
  if (values.length === 0) {
    // The text of a tag with no value is fixed at its place in the source, and a Code is never changed: it is made once.
    let constant = constants.get(strings);
    if (!constant) {
      constant = fromParts([{ kind: 'text', text: strings[0]! }]);
      constants.set(strings, constant);
    }
    return constant;
  }
  const only = values[0];
  // `${value}` alone is the value, unless the mark of an object literal would carry over (see `asObjectLiteral`).
  if (values.length === 1 && only && strings[0] === '' && strings[1] === '' && !only.objectLiteral) return only;
  return new TagCode(strings, values);
}

const constants = new WeakMap<TemplateStringsArray, Code>();

/** The Code that writes nothing. */
const NOTHING: Code = new PartsCode([]);

/** Code from the pieces of a list, with `separator` between them. */
export function join(pieces: readonly Code[], separator: Code = NOTHING): Code {
  // The list is the caller's, who may change it after the call: the Code keeps its own copy.
  return new JoinCode(pieces.slice(), separator);
}

/** A JSON literal of a value, such as a quoted string. */
export function literal(value: JsonValue): Code {
  return fromParts([{ kind: 'text', text: jsonText(value) }]);
}

/**
 * A JSON literal of a value that comes from a document, so its type is not known here, pretty-printed with `indent` spaces
 * when given. A value with no JSON text, such as `undefined`, is an error. An own `__proto__` key, at any depth, is written
 * as the computed key `["__proto__"]`: in an object literal the plain key would set the prototype and the key would vanish.
 */
export function documentLiteral(value: unknown, indent?: number): Code {
  const written = JSON.stringify(value, null, indent);
  if (written === undefined) throw new TypeError('documentLiteral cannot write a value that has no JSON text');
  if (!written.includes('"__proto__"')) return fromParts([{ kind: 'text', text: written }]);
  const plain: unknown = JSON.parse(written);
  if (!hasPrototypeKey(plain)) return fromParts([{ kind: 'text', text: written }]);
  return fromParts([{ kind: 'text', text: writeOwnPrototypeKeys(plain, Math.min(indent ?? 0, 10), 0) }]);
}

function hasPrototypeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrototypeKey);
  return typeof value === 'object' && value !== null && (Object.hasOwn(value, '__proto__') || Object.values(value).some(hasPrototypeKey));
}

/** JSON.stringify's layout of parsed JSON, with each `__proto__` key written as a computed key. */
function writeOwnPrototypeKeys(value: unknown, indent: number, level: number): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const newline = indent > 0 ? `\n${' '.repeat(indent * (level + 1))}` : '';
  const closing = indent > 0 ? `\n${' '.repeat(indent * level)}` : '';
  const members = Array.isArray(value)
    ? value.map((item) => writeOwnPrototypeKeys(item, indent, level + 1))
    : Object.entries(value).map(([key, child]) => {
      const name = key === '__proto__' ? `[${JSON.stringify(key)}]` : JSON.stringify(key);
      return `${name}:${indent > 0 ? ' ' : ''}${writeOwnPrototypeKeys(child, indent, level + 1)}`;
    });
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return members.length === 0 ? `${open}${close}` : `${open}${newline}${members.join(`,${newline}`)}${closing}${close}`;
}

function jsonText(value: JsonValue): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`literal cannot write ${value}`);
  return JSON.stringify(value);
}

/** A name that is written as it is, after a check that it is an identifier. */
export function identifier(name: string): Code {
  return fromParts([{ kind: 'text', text: checkedIdentifier(name, 'identifier'), identifier: true }]);
}

/** The code of an object literal, as the emitter that built the literal says. Any later change of the code drops the mark. */
export function asObjectLiteral(literalCode: Code): Code {
  return new TagCode(['', ''], [literalCode], true);
}

export function helper(id: string, define: () => Code, rank?: number): Helper {
  return { id: checkedIdentifier(id, 'helper id'), define, ...(rank === undefined ? {} : { rank }) };
}

/**
 * A helper that a file defines wherever its code names it, before the file's pieces: a generated function, or a variable
 * that the functions read. Two helpers of one id must have one definition.
 */
export function selfPlacedHelper(id: string, define: () => Code): Helper {
  return { ...helper(id, define), selfPlaced: true };
}

/** A call site of a helper: the name of the helper, and a request that the file holds its definition. */
export function helperName(target: Helper): Code {
  return fromParts([{ kind: 'helper', helper: target }]);
}

/** The name in an `export` declaration or an export list. `exportedNames` reads the exports of a file from these parts. */
export function exportedName(name: string): Code {
  return fromParts([{ kind: 'export', name: checkedIdentifier(name, 'export name') }]);
}

/** The names that a Code exports, and its helpers export, once each in order of appearance. */
export function exportedNames(root: Code): readonly string[] {
  const pieces = [root, ...helperDefinitions(root)];
  return [...new Set(pieces.flatMap((piece) => piece.parts.flatMap((part) => part.kind === 'export' ? [part.name] : [])))];
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

/** A documentation comment. The text cannot end the comment. */
export function docComment(text: string): Code {
  if (text.includes('*/')) throw new TypeError(`a comment cannot hold "*/", got ${JSON.stringify(text)}`);
  return fromParts([{ kind: 'text', text: `/** ${text} */` }]);
}

/** An object member key: bare when it is an identifier name, otherwise a string literal. */
export function propertyKey(name: string): Code {
  return PROPERTY_NAME.test(name) ? fromParts([{ kind: 'text', text: name, identifier: true }]) : literal(name);
}

/** A line end. Render writes the line break and the indentation of the `nest` that holds it. */
export const lineBreak: Code = fromParts([{ kind: 'line' }]);

/** The code with its line ends indented by `spaces` more spaces than the code around it. Render owns the indentation: no step edits the text. */
export function nest(body: Code, spaces: number = 2): Code {
  return fromParts([{ kind: 'indent', by: spaces }, ...body.parts, { kind: 'indent', by: -spaces }]);
}

/** Spaces at the start of a line. Whitespace names nothing, so it is the one text that needs no check. */
export function indentation(spaces: number): Code {
  let known = indentations.get(spaces);
  if (!known) {
    known = fromParts([{ kind: 'text', text: ' '.repeat(spaces) }]);
    indentations.set(spaces, known);
  }
  return known;
}

/** A Code is never changed, so the code of each width is made once. */
const indentations = new Map<number, Code>();

/** A line of code and the spaces before it. */
export interface IndentedLine {
  readonly spaces: number;
  readonly body: Code;
}

/** The lines with `separator` between them, each after its spaces: `join` of `code\`${indentation(spaces)}${body}\``, without a Code for each line. */
export function joinIndented(lines: readonly IndentedLine[], separator: Code): Code {
  // The list is the caller's, who may change it after the call: the Code keeps its own copy.
  return new LinesCode(lines.map(({ spaces, body }) => ({ spaces, body })), separator);
}

/**
 * The shape of an expression. An input part has the shape its slot was made with, so a piece never reads its text. A name,
 * an import and a checked identifier are names; any other code is `other`.
 */
export function readShape(expression: Code): ReadShape {
  const [only, ...more] = expression.parts;
  if (only === undefined || more.length > 0) return 'other';
  if (only.kind === 'input') return only.slot.shape;
  if (only.kind === 'name' || only.kind === 'imported' || (only.kind === 'text' && only.identifier === true)) return 'name';
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
interface ImportedName { readonly name: string; readonly alias?: string; readonly typeOnly?: true }

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

const collected = new WeakMap<Code, Collected>();

/** The key of a runtime name among the names of its module: the name, and its alias when it has one. */
function runtimeKey(part: { readonly name: string; readonly alias?: string }): string {
  return part.alias === undefined ? part.name : `${part.name}\0${part.alias}`;
}

/** What a Code needs, found by one walk of the Code and of the definitions of its helpers. A Code is read many times, so the walk runs once for each. */
function collect(root: Code): Collected {
  let known = collected.get(root);
  if (!known) {
    known = collectFrom(root);
    collected.set(root, known);
  }
  return known;
}

/** What the parts of one Code name: the runtime names, the imported names, and the helpers. */
interface Scanned {
  readonly runtime: Map<RuntimeModule, RuntimeNames>;
  readonly imported: Map<ImportSource, Set<Code>>;
  readonly needs: readonly Helper[];
}

function scanParts(piece: Code): Scanned {
  const runtime = new Map<RuntimeModule, RuntimeNames>();
  const imported = new Map<ImportSource, Set<Code>>();
  let needs: Set<Helper> | undefined;
  for (const part of piece.parts) {
    if (part.kind === 'runtime') {
      let names = runtime.get(part.module);
      if (!names) { names = { values: new Map<string, ImportedName>(), types: new Map<string, ImportedName>() }; runtime.set(part.module, names); }
      const kept = part.typeOnly ? names.types : names.values;
      const key = runtimeKey(part);
      if (!kept.has(key)) kept.set(key, { name: part.name, ...(part.alias === undefined ? {} : { alias: part.alias }), ...(part.typeOnly ? { typeOnly: true as const } : {}) });
    } else if (part.kind === 'imported') {
      let used = imported.get(part.source);
      if (!used) { used = new Set<Code>(); imported.set(part.source, used); }
      used.add(part.source.declaredFor(part));
    } else if (part.kind === 'helper') {
      (needs ??= new Set<Helper>()).add(part.helper);
    }
  }
  return { runtime, imported, needs: needs ? [...needs].sort(compareHelpers) : [] };
}

/** The definition of a helper and what it names, found once: many roots name the same helper, and a Code is never changed. */
const definitions = new WeakMap<Helper, { readonly definition: Code; readonly scanned: Scanned }>();

function collectFrom(root: Code): Collected {
  const rootScan = scanParts(root);
  const runtime = rootScan.runtime;
  const imported = rootScan.imported;
  const found = new Map<string, { readonly helper: Helper; readonly definition: Code; readonly needs: readonly Helper[] }>();
  const pending: Helper[] = [...rootScan.needs];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const known = found.get(next.id);
    if (known && known.helper === next) continue;
    if (known && !(known.helper.selfPlaced && next.selfPlaced)) throw new Error(`two helpers are named "${next.id}"`);
    let defined = definitions.get(next);
    if (!defined) {
      const definition = next.define();
      defined = { definition, scanned: scanParts(definition) };
      definitions.set(next, defined);
    }
    // Self-placed helpers of one id share one definition: the id is a hash of text, so two selectors that write the same text
    // (two imported classes of one name) would otherwise be merged without notice.
    if (known) {
      if (codeKey(known.definition) !== codeKey(defined.definition)) throw new Error(`two different self-placed helpers are named "${next.id}"`);
      continue;
    }
    const { definition, scanned } = defined;
    for (const [module, names] of scanned.runtime) {
      const into = runtime.get(module);
      if (!into) { runtime.set(module, { values: new Map(names.values), types: new Map(names.types) }); continue; }
      for (const [key, name] of names.values) if (!into.values.has(key)) into.values.set(key, name);
      for (const [key, name] of names.types) if (!into.types.has(key)) into.types.set(key, name);
    }
    for (const [source, names] of scanned.imported) {
      const into = imported.get(source);
      if (into) names.forEach((name) => into.add(name));
      else imported.set(source, new Set(names));
    }
    found.set(next.id, { helper: next, definition, needs: scanned.needs });
    pending.push(...scanned.needs);
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

interface RuntimeImport {
  readonly module: RuntimeModule;
  /** Each value name once, in the order of the file (see `ImportOptions.order`). */
  readonly names: readonly ImportedName[];
  /** Each type name once, with `typeOnly`. A name the code also uses as a value is not here. */
  readonly types: readonly ImportedName[];
}

/** The names of a module in the order of a file: the names its `order` lists come first in that order, then the others in code point order. */
function inOrder(names: Iterable<ImportedName>, listed: readonly string[] = []): readonly ImportedName[] {
  const place = (name: string): number => { const at = listed.indexOf(name); return at < 0 ? Infinity : at; };
  return [...names].sort((left, right) => place(left.name) === place(right.name) ? compareText(left.name, right.name) || compareText(left.alias ?? '', right.alias ?? '') : place(left.name) < place(right.name) ? -1 : 1);
}

/** How an import statement writes a runtime name: `name`, or `name as alias`. */
function spelledName({ name, alias }: ImportedName): string {
  return alias === undefined ? name : `${name} as ${alias}`;
}

/** The runtime parts of a Code and of the helpers it needs, grouped by module in the fixed module order. */
function importSet(root: Code, options: Pick<ImportOptions, 'order' | 'modules'> = {}): readonly RuntimeImport[] {
  const { order = {}, modules } = options;
  const position = (module: RuntimeModule): number => modules ? modules.indexOf(module) : RUNTIME_MODULE_RANK[module];
  const found = [...collect(root).runtime];
  const unlisted = found.find(([module]) => position(module) < 0);
  if (unlisted) throw new Error(`the code uses the runtime module "${unlisted[0]}", which the file does not list in its module order`);
  return found
    .sort(([left], [right]) => position(left) - position(right))
    .map(([module, { values, types }]) => ({
      module,
      names: inOrder(values.values(), order[module]),
      // A name the code uses as a value and as a type is imported once, as the value.
      types: inOrder([...types].filter(([key]) => !values.has(key)).map(([, type]) => type), order[module]),
    }));
}

/** How a file writes the imports of its runtime parts. */
export interface ImportOptions {
  /** The specifier of a runtime module, for its values and its types; a module not listed is imported from `RUNTIME_SPECIFIER` for values and `runtimeTypeSpecifier` for types. */
  readonly specifiers?: Partial<Readonly<Record<RuntimeModule, string>>>;
  /** The quote of a specifier; a single quote by default. */
  readonly quote?: "'" | '"';
  /**
   * How a specifier writes its type names: `separate` (the default) puts them in an `import type` statement before the value
   * statement; `inline` puts them after the values in one statement, each as `type Name`; `ordered` puts values and
   * types in one statement in the order of `order`, then the unlisted values, then the unlisted types. A specifier that
   * has type names only is always one `import type` statement.
   */
  readonly typeNames?: 'separate' | 'inline' | 'ordered';
  /** The runtime modules this call writes, in this order; a module that the code uses and the list lacks is an error. Without it, every module in the fixed order. */
  readonly modules?: readonly RuntimeModule[];
  /** The names of a module that a file with a fixed order lists: they come first, in this order, for values and types alike; the others follow in code point order. */
  readonly order?: Partial<Readonly<Record<RuntimeModule, readonly string[]>>>;
}

/** The names that a file takes from one specifier, and the runtime modules (rt keys) they come from. */
export interface ImportGroup {
  readonly specifier: string;
  readonly modules: readonly RuntimeModule[];
  /** Each value name once, in the order of the file (see `ImportOptions.order`). */
  readonly names: readonly ImportedName[];
  /** Each type name once, with `typeOnly`. A name the code also uses as a value is not here. */
  readonly types: readonly ImportedName[];
}

/**
 * The runtime parts of a Code grouped by the specifier a file imports them from, in module order: a value comes from the
 * internal entry of its module and a type from the public subpath, so a specifier is one statement however many modules
 * (rt keys) it serves.
 */
export function importGroups(root: Code, options: Pick<ImportOptions, 'order' | 'modules' | 'specifiers'> = {}): readonly ImportGroup[] {
  const groups = new Map<string, { modules: RuntimeModule[]; names: ImportedName[]; types: ImportedName[] }>();
  const into = (specifier: string, module: RuntimeModule): { modules: RuntimeModule[]; names: ImportedName[]; types: ImportedName[] } => {
    let group = groups.get(specifier);
    if (!group) groups.set(specifier, group = { modules: [], names: [], types: [] });
    if (!group.modules.includes(module)) group.modules.push(module);
    return group;
  };
  // Two modules (rt keys) can share a specifier, and a name that both use is imported once.
  const addOnce = (into: ImportedName[], added: readonly ImportedName[]): void => {
    for (const next of added) if (!into.some((have) => have.name === next.name && have.alias === next.alias)) into.push(next);
  };
  for (const { module, names, types } of importSet(root, options)) {
    const override = options.specifiers?.[module];
    if (names.length > 0) addOnce(into(override ?? RUNTIME_SPECIFIER[module], module).names, names);
    if (types.length > 0) addOnce(into(override ?? runtimeTypeSpecifier(module), module).types, types);
  }
  return [...groups].map(([specifier, group]) => ({ specifier, ...group }));
}

/**
 * The import statements of the runtime parts, in module order. A type name is never in a value import: it goes in an
 * `import type` statement before the value statement, or after the values as `type Name` when the file asks for `inline`.
 */
export function runtimeImports(root: Code, options: ImportOptions = {}): readonly Code[] {
  return importGroups(root, options).flatMap((group) => importLines(group, options));
}

/** The statements of one specifier of the import groups (see `runtimeImports`), for a file that puts other statements between specifiers. */
export function importLines({ specifier, modules, names, types }: ImportGroup, options: ImportOptions = {}): readonly Code[] {
  const quoted = options.quote === '"' ? jsonText(specifier) : `'${checkedSingleQuoted(specifier)}'`;
  const typeStatement = (listed: readonly ImportedName[]): Code => plainText(`import type { ${listed.map(spelledName).join(', ')} } from ${quoted};`);
  if (names.length === 0) return types.length > 0 ? [typeStatement(types)] : [];
  if (options.typeNames === 'inline') {
    const listed = [...names.map(spelledName), ...types.map((type) => `type ${spelledName(type)}`)];
    return [plainText(`import { ${listed.join(', ')} } from ${quoted};`)];
  }
  if (options.typeNames === 'ordered') {
    const listed = modules.flatMap((module) => options.order?.[module] ?? []);
    const place = ({ name }: ImportedName): number => { const at = listed.indexOf(name); return at < 0 ? Infinity : at; };
    const ordered = [...names, ...types]
      .sort((left, right) => place(left) === place(right) ? 0 : place(left) < place(right) ? -1 : 1)
      .map((member) => member.typeOnly ? `type ${spelledName(member)}` : spelledName(member));
    return [plainText(`import { ${ordered.join(', ')} } from ${quoted};`)];
  }
  return [
    ...(types.length > 0 ? [typeStatement(types)] : []),
    plainText(`import { ${names.map(spelledName).join(', ')} } from ${quoted};`),
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
    if (source.namespaceName !== undefined) return [plainText(`import ${source.typeStatement ? 'type ' : ''}* as ${source.namespaceName} from ${quoted};`)];
    const names = source.statement(used).map((part) => source.spelled(part));
    return [plainText(`import ${source.typeStatement ? 'type ' : ''}{ ${names.join(', ')} } from ${quoted};`)];
  });
}

/** An import statement that names no binding, only the module. */
export function sideEffectImport(specifier: string, quote: "'" | '"' = "'"): Code {
  return plainText(`import ${quote === '"' ? jsonText(specifier) : `'${checkedSingleQuoted(specifier)}'`};`);
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

const identities = new WeakMap<object, number>();
let identified = 0;

/** A number for an object that is the same each time, so a key tells two names, helpers or sources apart without reading their text. */
function identityOf(target: object): number {
  let known = identities.get(target);
  if (known === undefined) { known = identified++; identities.set(target, known); }
  return known;
}

/**
 * A key that two Codes share exactly when they write the same code: their parts match one by one, and each part matches by
 * kind. A runtime part is the same runtime export, an imported part the same name of the same source, a helper part the same
 * helper (a self-placed helper: the same id), a name part the same slot and an input part the same slot; none equals the text of its name. Adjacent text is one
 * text, so where the text was split into parts names nothing.
 */
export function codeKey(root: Code): string {
  let key = '';
  let text = '';
  for (const part of root.parts) {
    if (part.kind === 'text') {
      text += part.text;
      continue;
    }
    if (text !== '') { key += `${JSON.stringify(text)},`; text = ''; }
    switch (part.kind) {
      case 'runtime': key += `r${JSON.stringify([part.module, part.name, part.alias ?? null, part.typeOnly === true])},`; break;
      case 'imported': key += `i${JSON.stringify([identityOf(part.source), part.name, part.alias ?? null, part.typeOnly === true])},`; break;
      case 'helper': key += part.helper.selfPlaced ? `s${JSON.stringify(part.helper.id)},` : `h${identityOf(part.helper)},`; break;
      case 'name': key += `n${identityOf(part.slot)},`; break;
      case 'export': key += `e${JSON.stringify(part.name)},`; break;
      case 'input': key += `p${identityOf(part.slot)},`; break;
      case 'line': key += 'l,'; break;
      case 'indent': key += `d${part.by},`; break;
      default: return unreachable(part);
    }
  }
  return text === '' ? key : key + JSON.stringify(text);
}

function unreachable(part: never): never {
  throw new Error(`Internal error: unknown part ${JSON.stringify(part)}`);
}

/** Whether two Codes write the same code (see `codeKey`). */
export function sameCode(left: Code, right: Code): boolean {
  return codeKey(left) === codeKey(right);
}

/**
 * The one place that makes text. A runtime part is its export name and a helper part is its id. A name part reads the
 * table of the file. An input part must be bound before the Code is rendered.
 */
export function render(root: Code, names: NameTable = new NameTable()): string {
  let text = '';
  let depth = 0;
  // A line break writes the indentation when the next text comes, at the depth it has then: a line that ends a `nest`
  // is not indented as the nest, and a blank line holds no spaces.
  let lineStart = false;
  const write = (written: string): void => {
    if (written === '') return;
    if (lineStart && !written.startsWith('\n')) text += ' '.repeat(depth);
    lineStart = false;
    text += written;
  };
  for (const part of root.parts) {
    switch (part.kind) {
      case 'text': write(part.text); break;
      case 'runtime':
      case 'imported': write(part.alias ?? part.name); break;
      case 'helper': write(part.helper.id); break;
      case 'name': write(names.resolve(part.slot)); break;
      case 'export': write(part.name); break;
      case 'input': throw new Error(`the input "${part.slot.label}" is not bound`);
      case 'line': write('\n'); lineStart = true; break;
      case 'indent': depth += part.by; break;
      default: return unreachable(part);
    }
  }
  return text;
}

/** A rendered file, and the names it exports. */
export interface RenderedModule {
  readonly source: string;
  readonly exports: readonly string[];
}

/** `render`, and the exports of the Code. */
export function renderModule(root: Code, names: NameTable = new NameTable()): RenderedModule {
  return { source: render(root, names), exports: exportedNames(root) };
}

/**
 * The pieces of a file with each helper replaced by its definition, or dropped when `root` does not name it. Every helper
 * that `root` names must stand among the pieces, or be one of `writtenInCode`, whose definitions the code holds itself: a
 * file that names a helper it does not place would call a missing function.
 */
export function placeHelpers(root: Code, pieces: readonly (Code | Helper)[], writtenInCode: readonly Helper[] = []): readonly Code[] {
  const placed = new Set([...pieces.filter((piece): piece is Helper => 'define' in piece), ...writtenInCode]);
  const needed = helperSet(root);
  const missing = needed.find((each) => !each.selfPlaced && !placed.has(each));
  if (missing) throw new Error(`Internal error: the code names the helper "${missing.id}", which the file does not place.`);
  const defined = new Set(needed);
  const own = needed.filter((each) => each.selfPlaced && !placed.has(each)).flatMap((each) => [each.define(), code``]);
  return [
    ...own,
    ...pieces.flatMap((piece): readonly Code[] => 'define' in piece ? (defined.has(piece) ? [piece.define()] : []) : [piece]),
  ];
}
