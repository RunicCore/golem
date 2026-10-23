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
}

/**
 * A function that a file holds once, because code calls it. The definition may name other helpers, and may name this
 * helper: it is a function, so a helper that calls itself or another helper that calls it back is possible.
 */
export interface Helper {
  readonly id: string;
  readonly define: () => Code;
}

export type Part =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'runtime'; readonly module: RuntimeModule; readonly name: string }
  | { readonly kind: 'helper'; readonly helper: Helper }
  | { readonly kind: 'name'; readonly slot: NameSlot }
  | { readonly kind: 'input'; readonly slot: InputSlot };

export interface Code { readonly parts: readonly Part[] }

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
      if (last?.kind === 'text') merged[merged.length - 1] = { kind: 'text', text: last.text + part.text };
      else merged.push(part);
    } else merged.push(part);
  }
  return { parts: merged };
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
  return fromParts([{ kind: 'text', text: checkedIdentifier(name, 'identifier') }]);
}

/**
 * Text that an emitter has not moved to Code yet. The migration needs it; the last step deletes it. It is the only door
 * through which a string of code becomes a Code.
 */
export function legacyText(text: string): Code {
  return fromParts([{ kind: 'text', text }]);
}

export function helper(id: string, define: () => Code): Helper {
  return { id: checkedIdentifier(id, 'helper id'), define };
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

export function inputSlot(label: string, shape: ReadShape = 'other'): InputSlot {
  return { label, shape };
}

/** Code that an emitter wrote, or the text of a walker that does not return Code yet. */
export type Emitted = string | Code;

/** A string is wrapped as one text part. */
// migration door, deleted in steps 3b to 3d (T-284, T-285, T-286) for stringify-emitter and in steps 5 and 6 (T-288, T-289) for golem-model and golem-openapi
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
  if (only.kind === 'name') return 'name';
  // migration door, deleted in steps 3b to 3d (T-284, T-285, T-286): tests the text of a read that a caller wrote as a string
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
interface Collected {
  readonly runtime: Map<RuntimeModule, Set<string>>;
  readonly helpers: Map<string, { readonly helper: Helper; readonly definition: Code }>;
}

function collect(root: Code): Collected {
  const collected: Collected = { runtime: new Map(), helpers: new Map() };
  const pending: Code[] = [root];
  for (let next = pending.pop(); next; next = pending.pop()) {
    for (const part of next.parts) {
      if (part.kind === 'runtime') {
        const names = collected.runtime.get(part.module) ?? new Set<string>();
        names.add(part.name);
        collected.runtime.set(part.module, names);
      } else if (part.kind === 'helper') {
        const known = collected.helpers.get(part.helper.id);
        if (known) {
          if (known.helper !== part.helper) throw new Error(`two helpers are named "${part.helper.id}"`);
          continue;
        }
        const definition = part.helper.define();
        collected.helpers.set(part.helper.id, { helper: part.helper, definition });
        pending.push(definition);
      }
    }
  }
  return collected;
}

export interface RuntimeImport {
  readonly module: RuntimeModule;
  /** Each name once, in code point order. */
  readonly names: readonly string[];
}

/** The runtime parts of a Code and of the helpers it needs, grouped by module in the fixed module order. */
export function importSet(root: Code): readonly RuntimeImport[] {
  return [...collect(root).runtime]
    .sort(([left], [right]) => RUNTIME_MODULE_RANK[left] - RUNTIME_MODULE_RANK[right])
    .map(([module, names]) => ({ module, names: [...names].sort() }));
}

/** The import statements of the runtime parts, one line for each module. */
export function runtimeImports(root: Code): Code {
  return join(
    importSet(root).map(({ module, names }) => plainText(`import { ${names.join(', ')} } from '@exprtlabs/golem/${module}';\n`)),
  );
}

/** The helpers that a Code names, and the helpers that those helpers name, in code point order of their ids. */
export function helperSet(root: Code): readonly Helper[] {
  return [...collect(root).helpers.values()].map(({ helper: found }) => found).sort((left, right) => compareText(left.id, right.id));
}

/** The definitions of `helperSet`, separated by an empty line. */
export function helperBlock(root: Code): Code {
  return join(
    [...collect(root).helpers.values()]
      .sort((left, right) => compareText(left.helper.id, right.helper.id))
      .map(({ definition }) => definition),
    plainText('\n\n'),
  );
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
    part.kind === 'runtime' ? { kind: 'text', text: part.name }
      : part.kind === 'helper' ? { kind: 'text', text: part.helper.id }
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
      case 'runtime': text += part.name; break;
      case 'helper': text += part.helper.id; break;
      case 'name': text += names.resolve(part.slot); break;
      case 'input': throw new Error(`the input "${part.slot.label}" is not bound`);
    }
  }
  return text;
}
