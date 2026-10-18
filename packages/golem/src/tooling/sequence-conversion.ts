/**
 * The layout of generated tuple and array conversions, shared by the codec walkers (stringify, decode, encode) and the
 * model walker. A walker gives the conversion of one item; this module owns the loop, the position of each item and the
 * error path of an item. The guard sits only in `emitArrayConversion` and `emitTupleConversion`; `emitArrayItems` and
 * `emitTupleItems` have none. It imports no walker.
 */
import type { ModelTypeDescriptor } from '../model.js';

export type TupleConversionDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'tuple' }>;

/** The code of one converted item. */
export interface SequenceItem {
  /**
   * The item code, written against the value expression. It is the value expression itself when the item needs no
   * conversion. For `json` output, an item that needs none is `stringifyJsonScalar(<value> as never)`.
   */
  readonly code: string;
  /** The item code can throw, so it runs under the item index in the error path. */
  readonly throws: boolean;
}

export interface SequenceItems {
  /** 'value': a new array of converted values. 'json': JSON text. */
  readonly output: 'value' | 'json';
  /** The error kind for the path of an item that throws. Absent: no paths. */
  readonly paths?: 'serialize' | 'deserialize';
  /** The conversion of one item, written against `value`. */
  readonly item: (descriptor: ModelTypeDescriptor, value: string) => SequenceItem;
}

/**
 * Input identifier for a root field conversion emitted once to find its shape.
 * No nested conversion binds this name.
 */
export const FIELD_CONVERSION_INPUT = 'fieldValue';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The function name when a conversion emitted against `input` is exactly one call on it.
 * A caller passes that function and the value to `convertModelField` or `convertModelItems` instead of allocating a closure.
 */
export function singleCallConverter(converted: string, input: string = FIELD_CONVERSION_INPUT): string | undefined {
  const call = `(${input})`;
  if (!converted.endsWith(call)) return undefined;
  const name = converted.slice(0, -call.length);
  return IDENTIFIER.test(name) ? name : undefined;
}

const ITEM = 'item';
const INDEX = 'index';
const TUPLE = 'tuple';
/** What a `json` tuple writes for an item past the declared items, and for an item that needs no conversion. */
const JSON_SCALAR_ITEM = `stringifyJsonScalar(${ITEM} as never)`;

/** A name or a chain of property and index reads. Any other expression needs parentheses before `as`. */
const ACCESS_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:\d+|"[^"\\]*"|'[^'\\]*')\])*$/;

/** The array argument of a runtime loop function. */
function asArray(expression: string): string {
  return ACCESS_CHAIN.test(expression) ? `${expression} as readonly unknown[]` : `(${expression} as readonly unknown[])`;
}

/**
 * A whole array conversion, with its guard. An unchanged `value` array is a `slice`; a `json` array has no guard and
 * always writes its items.
 */
export function emitArrayConversion(item: ModelTypeDescriptor, expression: string, items: SequenceItems): string {
  const converted = emitArrayItems(item, expression, items);
  if (items.output === 'json') return converted;
  return `Array.isArray(${expression}) ? ${converted === expression ? `(${expression} as readonly unknown[]).slice()` : converted} : ${expression}`;
}

/**
 * The items of an array, with no guard. It returns `expression` when no item changes (`value` output). An item that
 * throws runs under its index in `convertModelItems`, which takes the item conversion as a function name when it is
 * one call, so a loop makes no function inside its own body.
 */
export function emitArrayItems(item: ModelTypeDescriptor, expression: string, items: SequenceItems): string {
  const { code, throws } = items.item(item, ITEM);
  if (items.output === 'json') return `stringifyJsonArray(${expression} as ArrayLike<unknown>, (${ITEM}) => ${code})`;
  if (code === ITEM) return expression;
  if (items.paths && throws) {
    return `convertModelItems(${JSON.stringify(items.paths)}, ${singleCallConverter(code, ITEM) ?? `(${ITEM}) => (${code})`}, ${asArray(expression)})`;
  }
  return `(${expression} as readonly unknown[]).map((${ITEM}) => ${code})`;
}

/**
 * A whole tuple conversion, with its guard: the items of `emitTupleItems` for an array, the input for anything else.
 * An unchanged `value` tuple is a `slice`; a `json` tuple writes its items, or a non-array as a scalar.
 */
export function emitTupleConversion(descriptor: TupleConversionDescriptor, expression: string, items: SequenceItems): string {
  const converted = emitTupleItems(descriptor, expression, items);
  if (items.output === 'json') return `(Array.isArray(${expression}) ? ${converted} : stringifyJsonScalar(${expression} as never))`;
  return `Array.isArray(${expression}) ? ${converted === expression ? `(${expression} as readonly unknown[]).slice()` : converted} : ${expression}`;
}

/**
 * The items of a tuple, with no guard. One loop over the input keeps its exact length: a short input stays short
 * and extra items stay. The loop callback selects the conversion by position; only items that change get a branch.
 * It returns `expression` when no item changes (`value` output). A callback finds the region of an item (before the
 * rest, the rest, after the rest) with `index` and `tuple`, and declares each one only when its own text reads it.
 */
export function emitTupleItems(descriptor: TupleConversionDescriptor, expression: string, items: SequenceItems): string {
  const json = items.output === 'json';
  const unchanged = json ? JSON_SCALAR_ITEM : ITEM;
  let usesIndex = false;
  let usesTuple = false;
  let pathed = false;

  const convert = (item: ModelTypeDescriptor): string => {
    const { code, throws } = items.item(item, ITEM);
    if (code !== unchanged && items.paths && throws) pathed = true;
    return code;
  };
  /**
   * The branches of the items that change, in order, each tested by `position`; the other items stay as they are.
   * A `closed` region holds only the listed positions, so when every item changes the last one needs no test.
   */
  const select = (codes: readonly string[], position: (index: number) => string, closed = false): string => {
    let selected = unchanged;
    let last = codes.length - 1;
    if (closed && codes.length > 0 && codes.every(code => code !== unchanged)) selected = codes[last--];
    for (let index = last; index >= 0; index--) {
      if (codes[index] === unchanged) continue;
      usesIndex = true;
      selected = `${position(index)} ? ${codes[index]} : ${selected}`;
    }
    return selected;
  };

  const rest = descriptor.rest;
  const restIndex = rest?.index ?? descriptor.items.length;
  const before = descriptor.items.slice(0, restIndex).map(convert);
  const middle = rest ? convert(rest.item) : unchanged;
  const afterItems = rest ? descriptor.items.slice(restIndex).map(convert) : [];
  // Items after the rest that convert as the rest does are part of it.
  const after = afterItems.every(code => code === middle) ? [] : afterItems;

  let selected: string;
  if (!rest || (middle === unchanged && after.every(code => code === unchanged))) {
    selected = select(before, index => `${INDEX} === ${index}`);
  } else {
    // The rest ends where the items after it begin. A short input has no rest, and its last items fill the positions
    // before the ones after the rest.
    const restEnd = `${TUPLE}.length - ${after.length}`;
    const afterStart = `Math.max(${restIndex}, ${restEnd})`;
    const afterSelected = after.length === 1
      ? after[0]
      : select(after, index => `${INDEX} - ${afterStart} === ${index}`, true);
    if (after.length > 0) {
      usesIndex = true;
      usesTuple = true;
    }
    if (restIndex > 0 && before.every(code => code === middle)) {
      // The items before the rest convert as the rest does, so the two regions are one.
      selected = after.length === 0 ? middle : `${INDEX} < ${afterStart} ? ${middle} : ${afterSelected}`;
    } else {
      const tail = after.length === 0 ? middle : `${INDEX} < ${restEnd} ? ${middle} : ${afterSelected}`;
      if (restIndex > 0) usesIndex = true;
      selected = restIndex > 0
        ? `${INDEX} < ${restIndex} ? ${select(before, index => `${INDEX} === ${index}`, true)} : ${tail}`
        : tail;
    }
  }

  const params = usesIndex ? `${ITEM}, ${INDEX}` : ITEM;
  if (pathed && items.paths) {
    // An item that throws runs under its index. A loop that selects by position gets the index and the array.
    const direction = JSON.stringify(items.paths);
    const array = asArray(expression);
    return usesIndex
      ? `convertModelTupleItems(${direction}, (${usesTuple ? `${params}, ${TUPLE}` : params}) => ${selected}, ${array})`
      : `convertModelItems(${direction}, ${singleCallConverter(selected, ITEM) ?? `(${ITEM}) => (${selected})`}, ${array})`;
  }
  if (json) {
    const write = `(${params}) => ${selected}`;
    return usesTuple
      ? `((${TUPLE}: readonly unknown[]) => stringifyJsonArray(${TUPLE}, ${write}))(${expression} as readonly unknown[])`
      : `stringifyJsonArray(${expression} as ArrayLike<unknown>, ${write})`;
  }
  if (selected === unchanged) return expression;
  return `(${expression} as readonly unknown[]).map((${usesTuple ? `${params}, ${TUPLE}` : params}) => ${selected})`;
}
