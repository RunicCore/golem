import { assertNever } from '../../assert-never.js';
import { codeKey, type Code, type InputSlot } from '../code.js';
import { FunctionSlots } from './function-names.js';

/** The fast check of a function as text, with what it calls. */
export interface WrittenFastCheck {
  /** The body; the full validators and fast checks it calls are name parts. */
  readonly body: Code;
  readonly calls: ReadonlySet<number>;
  readonly fastCalls: ReadonlySet<number>;
}

export interface WrittenFunction {
  readonly id: number;
  readonly parameters: Code;
  /** The body; the functions it calls are name parts. */
  readonly body: Code;
  readonly calls: ReadonlySet<number>;
  /** The fast check, for a function that has one. */
  readonly fast?: WrittenFastCheck;
}

/** The function a name part calls, and whether it calls the fast check. */
type Callee = { readonly id: number; readonly fast: boolean };

/**
 * The key of a body: its parts, and for each name part the group of the function it calls (and whether it is the fast
 * check). Two bodies with one key are the same code once each call names the group of its callee. The key of the parts
 * that name no callee is made once (`BodyKey`); each round of `groupFunctions` joins it to the groups of the callees.
 */
interface BodyKey {
  /** The key before the first callee, or of the whole body when it names no callee. */
  readonly head: string;
  /** The callees in order of appearance, each with the key that follows it, up to the next callee or the end. */
  readonly calls: readonly { readonly callee: Callee; after: string }[];
}

function bodyKeyOf(body: Code, slots: FunctionSlots): BodyKey {
  let head = '';
  const calls: { readonly callee: Callee; after: string }[] = [];
  let key = '';
  /** Ends the key between two callees: it follows the last callee, or is the head when there is none. */
  const endPiece = (): void => {
    const last = calls.at(-1);
    if (last === undefined) head = key;
    else last.after = key;
    key = '';
  };
  let text = '';
  for (const part of body.parts) {
    if (part.kind === 'text') {
      // Where the text was split into parts names nothing: adjacent text is one text.
      text += part.text;
      continue;
    }
    if (text !== '') { key += `${JSON.stringify(text)},`; text = ''; }
    switch (part.kind) {
      case 'name': {
        const callee = slots.owner(part.slot);
        if (callee === undefined) throw new Error(`The validator compiler body names "${part.slot.label}", which is no function.`);
        endPiece();
        calls.push({ callee, after: '' });
        break;
      }
      case 'runtime': key += `r${JSON.stringify([part.module, part.name, part.typeOnly === true, part.alias ?? null])},`; break;
      case 'imported': key += `i${JSON.stringify([part.source.specifier, part.name, part.typeOnly === true, part.alias ?? null])},`; break;
      case 'helper': key += `h${JSON.stringify(part.helper.id)},`; break;
      case 'export': key += `e${JSON.stringify(part.name)},`; break;
      case 'input': key += `p${inputNumber(part.slot)},`; break;
      case 'line': key += 'l,'; break;
      case 'indent': key += `d${part.by},`; break;
      default: return assertNever(part);
    }
  }
  if (text !== '') key += JSON.stringify(text);
  endPiece();
  return { head, calls };
}

function bodyKey({ head, calls }: BodyKey, groups: ReadonlyMap<number, number>): string {
  let key = head;
  for (const { callee, after } of calls) {
    const group = groups.get(callee.id);
    if (group === undefined) throw new Error(`The validator compiler has no emitted function for the schema function ${callee.id}.`);
    key += `n${callee.fast},${group},${after}`;
  }
  return key;
}

const inputNumbers = new WeakMap<InputSlot, number>();
let inputsNumbered = 0;

/** A number for an input slot that is the same each time, so bodies that read the same slot have the same key. */
function inputNumber(slot: InputSlot): number {
  const known = inputNumbers.get(slot);
  if (known !== undefined) return known;
  inputNumbers.set(slot, inputsNumbered);
  return inputsNumbered++;
}

/**
 * Groups the functions that behave alike: those with the same parameters whose bodies are the same code once each call
 * names the group of its callee. Groups start as one and split until stable, so recursive functions that mirror each
 * other (a model and its wire form) end up together. The fast check is no part of the key: it follows from the body, and
 * a model root and an operation root of the same schema must share one function whether or not the fast check is
 * written for both. A group is named by its lowest id that `fastReached` holds, else by its lowest id, so the group's
 * fast check is written from a function that has one.
 */
export function groupFunctions(written: readonly WrittenFunction[], fastReached: ReadonlySet<number>, slots: FunctionSlots): ReadonlyMap<number, number> {
  // The key of a body and the text of its parameters do not change between rounds; only the groups of the callees do.
  const keyed = written.map(entry => ({ id: entry.id, parameters: codeKey(entry.parameters), body: bodyKeyOf(entry.body, slots) }));
  let groups = new Map<number, number>(written.map(entry => [entry.id, 0]));
  let size = 1;
  for (;;) {
    const keys = new Map<string, number>();
    const next = new Map<number, number>();
    for (const { id, parameters, body } of keyed) {
      const key = `${groups.get(id)}\n${parameters}\n${bodyKey(body, groups)}`;
      let group = keys.get(key);
      if (group === undefined) keys.set(key, group = keys.size);
      next.set(id, group);
    }
    if (keys.size === size) break;
    groups = next;
    size = keys.size;
  }
  const lowest = new Map<number, number>();
  for (const entry of [...written].sort((first, second) => Number(fastReached.has(second.id)) - Number(fastReached.has(first.id)) || first.id - second.id)) {
    const group = groups.get(entry.id) ?? 0;
    if (!lowest.has(group)) lowest.set(group, entry.id);
  }
  return new Map(written.map(entry => [entry.id, lowest.get(groups.get(entry.id) ?? 0) ?? entry.id]));
}
