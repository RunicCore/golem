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
  /** The key between two callees, and after the last. */
  readonly pieces: readonly string[];
  /** The callees in order of appearance: `pieces` has one more entry than `callees`. */
  readonly callees: readonly Callee[];
}

function bodyKeyOf(body: Code, slots: FunctionSlots): BodyKey {
  const pieces: string[] = [];
  const callees: Callee[] = [];
  let key = '';
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
        pieces.push(key);
        key = '';
        callees.push(callee);
        break;
      }
      case 'runtime': key += `r${JSON.stringify([part.module, part.name, part.typeOnly === true, part.alias ?? null])},`; break;
      case 'imported': key += `i${JSON.stringify([part.source.specifier, part.name, part.typeOnly === true, part.alias ?? null])},`; break;
      case 'helper': key += `h${JSON.stringify(part.helper.id)},`; break;
      case 'export': key += `e${JSON.stringify(part.name)},`; break;
      case 'input': key += `p${inputNumber(part.slot)},`; break;
      case 'line': key += 'l,'; break;
      case 'indent': key += `d${part.by},`; break;
      default: return unreachablePart(part);
    }
  }
  pieces.push(text === '' ? key : key + JSON.stringify(text));
  return { pieces, callees };
}

function bodyKey({ pieces, callees }: BodyKey, groups: ReadonlyMap<number, number>): string {
  let key = pieces[0]!;
  for (let index = 0; index < callees.length; index += 1) {
    const callee = callees[index]!;
    const group = groups.get(callee.id);
    if (group === undefined) throw new Error(`The validator compiler has no emitted function for the schema function ${callee.id}.`);
    key += `n${callee.fast},${group},${pieces[index + 1]!}`;
  }
  return key;
}

function unreachablePart(part: never): never {
  throw new Error(`Internal error: the validator compiler body holds an unknown part ${JSON.stringify(part)}`);
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
  const keyed = new Map(written.map(entry => [entry.id, bodyKeyOf(entry.body, slots)]));
  const parameters = new Map(written.map(entry => [entry.id, codeKey(entry.parameters)]));
  let groups = new Map<number, number>(written.map(entry => [entry.id, 0]));
  let size = 1;
  for (;;) {
    const keys = new Map<string, number>();
    const next = new Map<number, number>();
    for (const entry of written) {
      const key = `${groups.get(entry.id)}\n${parameters.get(entry.id)}\n${bodyKey(keyed.get(entry.id)!, groups)}`;
      if (!keys.has(key)) keys.set(key, keys.size);
      next.set(entry.id, keys.get(key) ?? 0);
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
