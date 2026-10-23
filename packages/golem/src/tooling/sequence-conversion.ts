/**
 * The layout of generated tuple and array conversions, shared by the codec walkers (stringify, decode, encode) and the
 * model walker. A walker gives the conversion of one item; this module owns the loop, the position of each item and the
 * error path of an item. The guard sits only in `emitArrayConversion` and `emitTupleConversion`; `emitArrayItems` and
 * `emitTupleItems` have none. It imports no walker.
 */
import type { ModelTypeDescriptor } from '../model.js';
import { asObjectLiteral, code, emittedCode, identifier, legacyText, literal, readShape, sameCode, type Code, type Emitted } from './code.js';
import { rt } from './rt.js';

export type TupleConversionDescriptor = Extract<ModelTypeDescriptor, { readonly kind: 'tuple' }>;

/** The code of one converted item. */
export interface SequenceItem {
  /**
   * The item code, written against the value expression. It is the value expression itself when the item needs no
   * conversion. For `json` output, an item that needs none is `stringifyJsonScalar(<value> as never)`. A string is the
   * text of a walker that does not return Code yet.
   */
  readonly code: string | Code;
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
 * The function name when a conversion that a caller wrote as text, emitted against `input`, is exactly one call on it.
 * A caller passes that function and the value to `convertModelField` or `convertModelItems` instead of allocating a closure.
 */
// migration door, deleted in steps 5 and 6 (T-288, T-289): golem-model and golem-openapi call it
export function singleCallConverter(converted: string, input: string = FIELD_CONVERSION_INPUT): string | undefined {
  const call = `(${input})`;
  if (!converted.endsWith(call)) return undefined;
  const name = converted.slice(0, -call.length);
  return IDENTIFIER.test(name) ? name : undefined;
}

/**
 * The function of a conversion of `input` that is exactly one call on it. A call that an emitter wrote is a function part
 * and `(<input>)`. Text from a caller that does not return Code yet goes through `singleCallConverter`.
 */
export function calleeOf(converted: Code, input: string = FIELD_CONVERSION_INPUT): Code | undefined {
  const [first, second, ...more] = converted.parts;
  if (second === undefined) {
    const name = first?.kind === 'text' ? singleCallConverter(first.text, input) : undefined; // migration door, same steps as singleCallConverter
    return name === undefined ? undefined : identifier(name);
  }
  if (more.length > 0 || second.kind !== 'text' || second.text !== `(${input})`) return undefined;
  return first.kind === 'runtime' || first.kind === 'helper' || first.kind === 'name' ? { parts: [first] } : undefined;
}

const ITEM = identifier('item');
const INDEX = identifier('index');
const TUPLE = identifier('tuple');
/** What a `json` tuple writes for an item past the declared items, and for an item that needs no conversion. */
export const JSON_SCALAR = code`${rt.serde.stringifyJsonScalar}(${ITEM} as never)`;

/** The array argument of a runtime loop function. A name or a chain of reads needs no parentheses before `as`. */
function asArray(expression: Emitted): Code {
  const value = emittedCode(expression);
  return readShape(expression) !== 'other' ? code`${value} as readonly unknown[]` : code`(${value} as readonly unknown[])`;
}

/** An arrow body that is an object literal needs parentheses, or it parses as a block. */
function arrowBody(body: Code): Code {
  return body.objectLiteral ? code`(${body})` : body;
}

/** An item as the loop uses it: its code, the function when the code is one call on the item, and whether it can throw. */
interface ConvertedItem {
  readonly code: Code;
  readonly callee?: Code;
  readonly throws: boolean;
}

function convertedItem(item: SequenceItem): ConvertedItem {
  // migration door, deleted in steps 5 and 6 (T-288, T-289): the text of a walker that gives a string says it is an object literal by its first character
  const converted = typeof item.code !== 'string' ? item.code : item.code.startsWith('{') ? asObjectLiteral(legacyText(item.code)) : legacyText(item.code);
  return { code: converted, callee: calleeOf(converted, 'item'), throws: item.throws };
}

/** The result of an items emitter, and whether it is the value itself because no item changes. */
interface Converted {
  readonly code: Code;
  readonly unchanged: boolean;
}

/**
 * A whole array conversion, with its guard. An unchanged `value` array is a `slice`; a `json` array has no guard and
 * always writes its items.
 */
export function emitArrayConversion(item: ModelTypeDescriptor, expression: Emitted, items: SequenceItems): Code {
  const value = emittedCode(expression);
  const { code: converted, unchanged } = arrayItems(item, expression, items);
  if (items.output === 'json') return converted;
  return code`Array.isArray(${value}) ? ${unchanged ? code`(${value} as readonly unknown[]).slice()` : converted} : ${value}`;
}

/**
 * The items of an array, with no guard. It returns `expression` when no item changes (`value` output). An item that
 * throws runs under its index in `convertModelItems`, which takes the item conversion as a function name when it is
 * one call, so a loop makes no function inside its own body.
 */
export function emitArrayItems(item: ModelTypeDescriptor, expression: Emitted, items: SequenceItems): Code {
  return arrayItems(item, expression, items).code;
}

function arrayItems(item: ModelTypeDescriptor, expression: Emitted, items: SequenceItems): Converted {
  const value = emittedCode(expression);
  const converted = convertedItem(items.item(item, 'item'));
  if (items.output === 'json') {
    return { code: code`${rt.serde.stringifyJsonArray}(${value} as ArrayLike<unknown>, (${ITEM}) => ${arrowBody(converted.code)})`, unchanged: false };
  }
  if (sameCode(converted.code, ITEM)) return { code: value, unchanged: true };
  if (items.paths && converted.throws) {
    return {
      code: code`${rt.conversion.convertModelItems}(${literal(items.paths)}, ${converted.callee ?? code`(${ITEM}) => (${converted.code})`}, ${asArray(expression)})`,
      unchanged: false,
    };
  }
  return { code: code`(${value} as readonly unknown[]).map((${ITEM}) => ${arrowBody(converted.code)})`, unchanged: false };
}

/**
 * A whole tuple conversion, with its guard: the items of `emitTupleItems` for an array, the input for anything else.
 * An unchanged `value` tuple is a `slice`; a `json` tuple writes its items, or a non-array as a scalar.
 */
export function emitTupleConversion(descriptor: TupleConversionDescriptor, expression: Emitted, items: SequenceItems): Code {
  const value = emittedCode(expression);
  const { code: converted, unchanged } = tupleItems(descriptor, expression, items);
  if (items.output === 'json') return code`(Array.isArray(${value}) ? ${converted} : ${rt.serde.stringifyJsonScalar}(${value} as never))`;
  return code`Array.isArray(${value}) ? ${unchanged ? code`(${value} as readonly unknown[]).slice()` : converted} : ${value}`;
}

/**
 * The items of a tuple, with no guard. One loop over the input keeps its exact length: a short input stays short
 * and extra items stay. The loop callback selects the conversion by position; only items that change get a branch.
 * It returns `expression` when no item changes (`value` output). A callback finds the region of an item (before the
 * rest, the rest, after the rest) with `index` and `tuple`, and declares each one only when its own code reads it.
 */
export function emitTupleItems(descriptor: TupleConversionDescriptor, expression: Emitted, items: SequenceItems): Code {
  return tupleItems(descriptor, expression, items).code;
}

function tupleItems(descriptor: TupleConversionDescriptor, expression: Emitted, items: SequenceItems): Converted {
  const value = emittedCode(expression);
  const json = items.output === 'json';
  const unchanged: ConvertedItem = { code: json ? JSON_SCALAR : ITEM, throws: false };
  const isUnchanged = (converted: ConvertedItem): boolean => sameCode(converted.code, unchanged.code);
  let usesIndex = false;
  let usesTuple = false;
  let pathed = false;

  const convert = (item: ModelTypeDescriptor): ConvertedItem => {
    const converted = convertedItem(items.item(item, 'item'));
    if (!isUnchanged(converted) && items.paths && converted.throws) pathed = true;
    return converted;
  };
  /**
   * The branches of the items that change, in order, each tested by `position`; the other items stay as they are.
   * A `closed` region holds only the listed positions, so when every item changes the last one needs no test.
   */
  const select = (converted: readonly ConvertedItem[], position: (index: number) => Code, closed = false): ConvertedItem => {
    let selected = unchanged;
    let last = converted.length - 1;
    if (closed && converted.length > 0 && converted.every(item => !isUnchanged(item))) selected = converted[last--];
    for (let index = last; index >= 0; index--) {
      if (isUnchanged(converted[index])) continue;
      usesIndex = true;
      selected = { code: code`${position(index)} ? ${converted[index].code} : ${selected.code}`, throws: false };
    }
    return selected;
  };

  const rest = descriptor.rest;
  const restIndex = rest?.index ?? descriptor.items.length;
  const before = descriptor.items.slice(0, restIndex).map(convert);
  const middle = rest ? convert(rest.item) : unchanged;
  const afterItems = rest ? descriptor.items.slice(restIndex).map(convert) : [];
  // Items after the rest that convert as the rest does are part of it.
  const after = afterItems.every(item => sameCode(item.code, middle.code)) ? [] : afterItems;

  let selected: ConvertedItem;
  if (!rest || (isUnchanged(middle) && after.every(isUnchanged))) {
    selected = select(before, index => code`${INDEX} === ${literal(index)}`);
  } else {
    // The rest ends where the items after it begin. A short input has no rest, and its last items fill the positions
    // before the ones after the rest.
    const restEnd = code`${TUPLE}.length - ${literal(after.length)}`;
    const afterStart = code`Math.max(${literal(restIndex)}, ${restEnd})`;
    const afterSelected = after.length === 1
      ? after[0]
      : select(after, index => code`${INDEX} - ${afterStart} === ${literal(index)}`, true);
    if (after.length > 0) {
      usesIndex = true;
      usesTuple = true;
    }
    if (restIndex > 0 && before.every(item => sameCode(item.code, middle.code))) {
      // The items before the rest convert as the rest does, so the two regions are one.
      selected = after.length === 0 ? middle : { code: code`${INDEX} < ${afterStart} ? ${middle.code} : ${afterSelected.code}`, throws: false };
    } else {
      const tail = after.length === 0 ? middle : { code: code`${INDEX} < ${restEnd} ? ${middle.code} : ${afterSelected.code}`, throws: false };
      if (restIndex > 0) usesIndex = true;
      selected = restIndex > 0
        ? { code: code`${INDEX} < ${literal(restIndex)} ? ${select(before, index => code`${INDEX} === ${literal(index)}`, true).code} : ${tail.code}`, throws: false }
        : tail;
    }
  }

  const params = usesIndex ? code`${ITEM}, ${INDEX}` : ITEM;
  if (pathed && items.paths) {
    // An item that throws runs under its index. A loop that selects by position gets the index and the array.
    const direction = literal(items.paths);
    const array = asArray(expression);
    return {
      code: usesIndex
        ? code`${rt.conversion.convertModelTupleItems}(${direction}, (${usesTuple ? code`${params}, ${TUPLE}` : params}) => ${arrowBody(selected.code)}, ${array})`
        : code`${rt.conversion.convertModelItems}(${direction}, ${selected.callee ?? code`(${ITEM}) => (${selected.code})`}, ${array})`,
      unchanged: false,
    };
  }
  if (json) {
    const write = code`(${params}) => ${arrowBody(selected.code)}`;
    return {
      code: usesTuple
        ? code`((${TUPLE}: readonly unknown[]) => ${rt.serde.stringifyJsonArray}(${TUPLE}, ${write}))(${value} as readonly unknown[])`
        : code`${rt.serde.stringifyJsonArray}(${value} as ArrayLike<unknown>, ${write})`,
      unchanged: false,
    };
  }
  if (isUnchanged(selected)) return { code: value, unchanged: true };
  return { code: code`(${value} as readonly unknown[]).map((${usesTuple ? code`${params}, ${TUPLE}` : params}) => ${arrowBody(selected.code)})`, unchanged: false };
}
