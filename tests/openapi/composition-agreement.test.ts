import { copyFixtureFile, createFixtureProject, fileFixtureScope, onceShared } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { generate } from '#openapi/generator';
import { compileGeneratedSdk, generateMaterializedSdk, requireRecord, sdkBodyCodec, type SdkBodyCodec } from './helpers.js';

/**
 * One row is one allOf shape. For each row the generated SDK is checked on every path that reads the shape: the generated type
 * (a compile-time fixture), the client (a response body it decodes, a request body it encodes and checks), and the validators, with validation on and off.
 *
 * `additionalProperties` inside an allOf member follows strict JSON Schema: a member judges every name that it does not list in
 * its own `properties`, the names of its siblings included.
 */

type Wire = Record<string, unknown>;
type Fields = Record<string, unknown>;

interface Accepted {
  /** The JSON the codec reads and writes. */
  readonly wire: Wire;
  /** The decoded value. */
  readonly model: Fields;
}

interface Row {
  readonly shape: string;
  /** The file in tests/fixtures/openapi/composition that states the generated type; a row without one checks no type. */
  readonly fixture?: string;
  /** The generated model that the claims read. */
  readonly root: string;
  readonly document: Record<string, unknown>;
  readonly accepted: readonly Accepted[];
  /** Inputs that the codec rejects on decode with validation on. */
  readonly rejected: readonly Wire[];
  /** The composition warnings of generation, each as `code: message`; a row without it expects none. */
  readonly warnings?: readonly RegExp[];
}

const AT = '2024-05-06T07:08:09.000Z';
const B = '2024-05-07T08:09:10.000Z';
const dateTime = { type: 'string', format: 'date-time' };
const text = { type: 'string' };

/** A `Visit` object whose one field `m` (or the named property) holds the schema under test. */
function visitDocument(properties: Record<string, unknown>, components: Record<string, unknown> = {}): Record<string, unknown> {
  return componentDocument('Visit', {
    Visit: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
    ...components,
  });
}

function componentDocument(root: string, schemas: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Composition', version: '1' },
    paths: {
      '/root': {
        get: {
          operationId: 'getRoot',
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/${root}` } } } },
          },
        },
      },
    },
    components: { schemas },
  };
}

const ref = (name: string): Record<string, unknown> => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...more,
});

const rows: readonly Row[] = [
  {
    shape: 'disjoint inline objects (T-80, T-91)',
    fixture: 'disjoint-objects',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ at: dateTime }), object({ b: dateTime })] } }),
    accepted: [
      { wire: { m: { at: AT, b: B } }, model: { m: { at: new Date(AT), b: new Date(B) } } },
      { wire: { m: { b: B } }, model: { m: { b: new Date(B) } } },
      { wire: { m: {} }, model: { m: {} } },
    ],
    rejected: [],
  },
  {
    shape: 'own properties plus an allOf member that adds properties (T-80)',
    fixture: 'own-plus-member',
    root: 'Visit',
    document: visitDocument({ m: { type: 'object', properties: { at: dateTime }, allOf: [{ properties: { b: dateTime } }] } }),
    accepted: [
      { wire: { m: { at: AT, b: B } }, model: { m: { at: new Date(AT), b: new Date(B) } } },
      { wire: { m: { b: B } }, model: { m: { b: new Date(B) } } },
      { wire: { m: {} }, model: { m: {} } },
    ],
    rejected: [],
  },
  {
    shape: 'an allOf member requires an own property',
    fixture: 'required-member',
    root: 'Visit',
    document: visitDocument({ m: { type: 'object', properties: { at: dateTime }, allOf: [{ required: ['at'] }] } }),
    accepted: [{ wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } }],
    rejected: [{ m: {} }],
  },
  {
    shape: 'array of allOf object members (T-94)',
    fixture: 'array-items',
    root: 'Visit',
    document: visitDocument({
      e: { type: 'array', items: { allOf: [object({ a: dateTime }), object({ b: dateTime })] } },
    }),
    accepted: [
      { wire: { e: [{ a: AT, b: B }, { a: AT }] }, model: { e: [{ a: new Date(AT), b: new Date(B) }, { a: new Date(AT) }] } },
      { wire: { e: [] }, model: { e: [] } },
    ],
    rejected: [],
  },
  {
    shape: 'a constraint-only allOf member (minProperties) beside own properties',
    fixture: 'constraint-only',
    root: 'Visit',
    document: visitDocument({ m: { type: 'object', properties: { at: dateTime }, allOf: [{ minProperties: 1 }] } }),
    accepted: [{ wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } }],
    rejected: [{ m: {} }],
  },
  {
    shape: 'a nullable object with a constraint-only allOf member',
    fixture: 'nullable-constraint-only',
    root: 'Visit',
    document: visitDocument({ m: { type: ['object', 'null'], properties: { at: dateTime }, allOf: [{ minProperties: 1 }] } }),
    accepted: [
      { wire: { m: null }, model: { m: null } },
      { wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } },
    ],
    rejected: [{ m: {} }],
  },
  {
    shape: 'inheritance: a component allOf [$ref Base, own properties]',
    fixture: 'inheritance',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ baseAt: dateTime, label: text }, { required: ['baseAt'] }),
      Derived: { allOf: [ref('Base'), object({ derivedAt: dateTime }, { required: ['derivedAt'] })] },
    }),
    accepted: [
      { wire: { baseAt: AT, label: 'l', derivedAt: B }, model: { baseAt: new Date(AT), label: 'l', derivedAt: new Date(B) } },
      { wire: { baseAt: AT, derivedAt: B }, model: { baseAt: new Date(AT), derivedAt: new Date(B) } },
    ],
    rejected: [{ derivedAt: B }],
  },
  {
    shape: 'polymorphism: Pet is oneOf [Cat, Dog] and each variant is allOf [$ref PetBase, own properties]',
    fixture: 'polymorphism',
    root: 'Pet',
    document: componentDocument('Pet', {
      PetBase: object({ kind: text }, { required: ['kind'] }),
      Cat: { allOf: [ref('PetBase'), object({ kind: { const: 'cat' }, name: text, born: dateTime }, { required: ['kind', 'name'] })] },
      Dog: { allOf: [ref('PetBase'), object({ kind: { const: 'dog' }, name: text }, { required: ['kind', 'name'] })] },
      Pet: {
        oneOf: [ref('Cat'), ref('Dog')],
        discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } },
      },
    }),
    accepted: [
      { wire: { kind: 'cat', name: 'n', born: AT }, model: { kind: 'cat', name: 'n', born: new Date(AT) } },
      { wire: { kind: 'dog', name: 'n' }, model: { kind: 'dog', name: 'n' } },
    ],
    rejected: [{ kind: 'cat' }],
  },
  {
    shape: 'a narrowed property with an equal conversion (const over string)',
    fixture: 'narrowed-equal',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ kind: text, at: dateTime }, { required: ['kind'] }),
      Derived: { allOf: [ref('Base'), object({ kind: { const: 'cat' }, name: text }, { required: ['kind'] })] },
    }),
    accepted: [{ wire: { kind: 'cat', at: AT, name: 'n' }, model: { kind: 'cat', at: new Date(AT), name: 'n' } }],
    rejected: [{ kind: 'dog', name: 'n' }],
  },
  // Strict JSON Schema for additionalProperties inside allOf: the validator already rejects these inputs and must keep doing so.
  {
    shape: 'strict b1: an additionalProperties string member rejects a number sibling',
    fixture: 'strict-b1',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [{ type: 'object', additionalProperties: text }, object({ n: { type: 'number' } })] } }),
    accepted: [
      { wire: { m: {} }, model: { m: {} } },
      { wire: { m: { x: 'q' } }, model: { m: { x: 'q' } } },
    ],
    rejected: [{ m: { n: 1 } }],
    // The type of a name that the validator always rejects is `n?: never`. No member is closed: the types do not intersect.
    warnings: [/^OPENAPI_COMPOSITION_PROPERTY_NEVER: Property "n" of schema "Visit" at #\/components\/schemas\/Visit\/properties\/m has no value that every member accepts/],
  },
  {
    shape: 'strict b1: the same members accept a string sibling',
    fixture: 'strict-b1-string',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [{ type: 'object', additionalProperties: text }, object({ n: text })] } }),
    accepted: [{ wire: { m: { n: 'a' } }, model: { m: { n: 'a' } } }],
    rejected: [{ m: { n: 1 } }],
  },
  {
    shape: 'strict b2: an additionalProperties false member rejects a sibling property',
    fixture: 'strict-b2',
    root: 'Visit',
    document: visitDocument({
      m: { allOf: [{ type: 'object', additionalProperties: false, properties: { a: text } }, object({ b: text })] },
    }),
    accepted: [{ wire: { m: { a: 'x' } }, model: { m: { a: 'x' } } }],
    rejected: [{ m: { a: 'x', b: 'y' } }, { m: { b: 'y' } }],
    // The type shows `b?: never`.
    warnings: [/^OPENAPI_COMPOSITION_PROPERTY_NEVER: Property "b" of schema "Visit" at #\/components\/schemas\/Visit\/properties\/m .*allOf member \d sets additionalProperties: false\. Replace it with unevaluatedProperties: false/],
  },
  // A closed base with a derived optional own property: the validator rejects `b`, and the type shows `b?: never`.
  {
    shape: 'closed base and a component with an optional own property',
    fixture: 'closed-base-optional',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: { type: 'object', additionalProperties: false, properties: { a: text } },
      Derived: { allOf: [ref('Base'), object({ b: dateTime })] },
    }),
    accepted: [{ wire: { a: 'x' }, model: { a: 'x' } }],
    rejected: [{ a: 'x', b: B }, { b: B }],
    warnings: [/^OPENAPI_COMPOSITION_PROPERTY_NEVER: Property "b" of schema "Derived" at #\/components\/schemas\/Derived .*Remove additionalProperties: false/],
  },
  // protects: T-279 an optional property that one member types as date-time and another as a model is disjoint: `x?: never` and a warning
  {
    shape: 'members that type an optional property as a Date and as a model',
    fixture: 'date-and-model-optional',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ x: dateTime }), object({ x: ref('M') })] } }, { M: object({ n: text }) }),
    accepted: [{ wire: { m: {} }, model: { m: {} } }],
    rejected: [{ m: { x: AT } }, { m: { x: { n: 'a' } } }],
    warnings: [/^OPENAPI_COMPOSITION_PROPERTY_NEVER: Property "x" of schema "Visit" at #\/components\/schemas\/Visit\/properties\/m has no value that every member accepts/],
  },
  // The user's answer: strict JSON Schema, and `unevaluatedProperties: false` closes an object to every name that any member
  // declares. An open base and a derived component that sets it accept the base and own names and reject any other name.
  {
    shape: 'a component whose own allOf member is closed rejects an optional base property',
    root: 'Cat',
    document: componentDocument('Cat', {
      Pet: object({ name: text }),
      Cat: { allOf: [ref('Pet'), object({ meow: text }, { additionalProperties: false })] },
    }),
    accepted: [{ wire: { meow: 'm' }, model: { meow: 'm' } }],
    rejected: [{ meow: 'm', name: 'n' }],
    warnings: [/^OPENAPI_COMPOSITION_PROPERTY_NEVER: Property "name" of schema "Cat" at #\/components\/schemas\/Cat .*allOf member 1 sets additionalProperties: false\. Replace it with unevaluatedProperties: false beside the allOf\./],
  },
  {
    shape: 'an open base and a component with unevaluatedProperties false',
    fixture: 'unevaluated-open-base',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ a: text }),
      Derived: { allOf: [ref('Base'), object({ b: dateTime })], unevaluatedProperties: false },
    }),
    accepted: [{ wire: { a: 'x', b: B }, model: { a: 'x', b: new Date(B) } }],
    rejected: [{ a: 'x', b: B, z: 'q' }],
  },
  // The T-99 shapes reject invalid input as strict JSON Schema does.
  {
    shape: 'T-99b strict: an additionalProperties string member rejects a number name',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [{ type: 'object', additionalProperties: text }, object({ at: dateTime })] } }),
    accepted: [],
    rejected: [{ m: { other: 1 } }],
  },
  {
    shape: 'T-99c strict: a member with properties and additionalProperties rejects a number name',
    root: 'Visit',
    document: visitDocument({
      m: { allOf: [object({ a: text }, { additionalProperties: text }), object({ at: dateTime })] },
    }),
    accepted: [],
    rejected: [{ m: { z: 1 } }],
  },
  {
    shape: 'T-96: a nullable object with own properties and an allOf object member',
    fixture: 'nullable-own-plus-member',
    root: 'Visit',
    document: visitDocument({ m: { type: ['object', 'null'], properties: { at: dateTime }, allOf: [{ properties: { b: dateTime } }] } }),
    accepted: [
      { wire: { m: null }, model: { m: null } },
      { wire: { m: { at: AT, b: B } }, model: { m: { at: new Date(AT), b: new Date(B) } } },
    ],
    rejected: [],
  },
  {
    shape: 'T-98: own properties plus an allOf $ref member',
    fixture: 'own-plus-reference',
    root: 'Visit',
    document: visitDocument(
      { m: { type: 'object', properties: { at: dateTime }, allOf: [ref('Base')] } },
      { Base: object({ name: text }) },
    ),
    accepted: [{ wire: { m: { at: AT, name: 'x' } }, model: { m: { at: new Date(AT), name: 'x' } } }],
    rejected: [],
  },
  {
    shape: 'T-98: an inline allOf of a $ref member and a properties member',
    fixture: 'inline-reference-plus-properties',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [ref('Base'), object({ at: dateTime })] } },
      { Base: object({ name: text }) },
    ),
    accepted: [{ wire: { m: { at: AT, name: 'x' } }, model: { m: { at: new Date(AT), name: 'x' } } }],
    rejected: [],
  },
  {
    shape: 'T-99a: two members declare the same property',
    fixture: 'same-name-members',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ at: dateTime }), object({ at: dateTime })] } }),
    accepted: [
      { wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } },
      { wire: { m: {} }, model: { m: {} } },
    ],
    rejected: [],
  },
  {
    shape: 'T-99b: an additionalProperties-only member beside a date property',
    fixture: 'additional-only-member',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [{ type: 'object', additionalProperties: text }, object({ at: dateTime })] } }),
    accepted: [
      { wire: { m: { at: AT, other: 'x' } }, model: { m: { at: new Date(AT), other: 'x' } } },
      { wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } },
    ],
    rejected: [{ m: { other: 1 } }],
  },
  {
    shape: 'strict b3: a date property, then an additionalProperties string member',
    fixture: 'additional-member-after-date',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ at: dateTime }), { type: 'object', additionalProperties: text }] } }),
    accepted: [{ wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } }],
    rejected: [{ m: { x: 1 } }],
  },
  {
    shape: 'T-99c: a member with properties and additionalProperties beside a date property',
    fixture: 'additional-plus-property',
    root: 'Visit',
    document: visitDocument({
      m: { allOf: [object({ a: text }, { additionalProperties: text }), object({ at: dateTime })] },
    }),
    accepted: [
      { wire: { m: { a: 'x', at: AT } }, model: { m: { a: 'x', at: new Date(AT) } } },
      { wire: { m: { at: AT, z: 'q' } }, model: { m: { at: new Date(AT), z: 'q' } } },
    ],
    rejected: [{ m: { z: 1 } }],
  },
  {
    shape: 'T-99: own additionalProperties dates plus an allOf properties member',
    fixture: 'own-additional-plus-member',
    root: 'Visit',
    document: visitDocument({
      m: { type: 'object', additionalProperties: dateTime, allOf: [object({ b: dateTime })] },
    }),
    accepted: [
      { wire: { m: { b: B } }, model: { m: { b: new Date(B) } } },
      { wire: { m: { x: AT, b: B } }, model: { m: { x: new Date(AT), b: new Date(B) } } },
    ],
    rejected: [{ m: { x: 1 } }],
  },
  // A property that wraps one model reference stays that model, and a model may wrap a reference to itself.
  {
    shape: 'a property that wraps one model $ref in allOf with a description',
    fixture: 'reference-wrapper',
    root: 'Visit',
    document: visitDocument(
      { owner: { allOf: [ref('Person')], description: 'Owner' } },
      { Person: object({ name: text, born: dateTime }) },
    ),
    accepted: [{
      wire: { owner: { name: 'n', born: AT } },
      model: { owner: { name: 'n', born: new Date(AT) } },
    }],
    rejected: [{ owner: { born: 1 } }],
  },
  {
    shape: 'a model whose properties wrap a $ref to itself in allOf',
    fixture: 'self-reference-wrapper',
    root: 'TreeNode',
    document: componentDocument('TreeNode', {
      TreeNode: object({
        name: text,
        parent: { allOf: [ref('TreeNode')], description: 'Up' },
        children: { type: 'array', items: { allOf: [ref('TreeNode')] } },
      }),
    }),
    accepted: [{
      wire: { name: 'r', parent: { name: 'p' }, children: [{ name: 'c' }] },
      model: {
        name: 'r',
        parent: { name: 'p' },
        children: [{ name: 'c' }],
      },
    }],
    rejected: [{ name: 'r', parent: { name: 1 } }],
  },
  // JSON Schema AND: a derived member that narrows a nullable base date to a date is a date, not a conflict.
  {
    shape: 'a derived component narrows a nullable base date-time to a date-time',
    fixture: 'narrowed-nullable-date',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ deletedAt: { type: ['string', 'null'], format: 'date-time' } }),
      Derived: { allOf: [ref('Base'), object({ deletedAt: dateTime })] },
    }),
    accepted: [{ wire: { deletedAt: AT }, model: { deletedAt: new Date(AT) } }],
    rejected: [{ deletedAt: null }],
  },
  // Two members declare one object property: the objects resolve as one allOf, also when both convert a date in it.
  {
    shape: 'two members declare one object property with dates under different names',
    fixture: 'same-name-objects',
    root: 'Visit',
    document: visitDocument({
      m: { allOf: [object({ o: object({ at: dateTime }) }), object({ o: object({ b: text, when: dateTime }) })] },
    }),
    accepted: [
      { wire: { m: { o: { at: AT, b: 'x', when: B } } }, model: { m: { o: { at: new Date(AT), b: 'x', when: new Date(B) } } } },
      { wire: { m: { o: { b: 'x' } } }, model: { m: { o: { b: 'x' } } } },
    ],
    rejected: [{ m: { o: { b: 5 } } }],
  },
  // A member's additionalProperties schema constrains the wire value of a sibling's date-time; the date still decides. The
  // model holds a Date, so only the wire check sees the string (spec 4.7).
  {
    shape: 'an additionalProperties pattern member constrains a date-time sibling',
    fixture: 'additional-pattern-date',
    root: 'Visit',
    document: visitDocument({
      m: { allOf: [{ type: 'object', additionalProperties: { type: 'string', pattern: '^2024-' } }, object({ at: dateTime })] },
    }),
    accepted: [{ wire: { m: { at: AT } }, model: { m: { at: new Date(AT) } } }],
    rejected: [{ m: { at: '2023-05-06T07:08:09.000Z' } }],
  },
  // A oneOf of a model and a string AND that model is the model, whichever direction the conversion is read in.
  {
    shape: 'a member narrows a oneOf of a model and a string to that model',
    fixture: 'narrowed-model-union',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [object({ x: { oneOf: [ref('M'), text] } }), object({ x: ref('M') })] } },
      { M: object({ n: text }) },
    ),
    accepted: [{ wire: { m: { x: { n: 'a' } } }, model: { m: { x: { n: 'a' } } } }],
    rejected: [{ m: { x: 'a' } }],
  },
  {
    shape: 'a member narrows a oneOf of a model and a string to its object variant',
    fixture: 'narrowed-object-variant',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [object({ x: { oneOf: [ref('M'), text] } }), object({ x: object({ n: text }) })] } },
      { M: object({ n: text }) },
    ),
    accepted: [{ wire: { m: { x: { n: 'a' } } }, model: { m: { x: { n: 'a' } } } }],
    rejected: [{ m: { x: 'a' } }],
  },
  // An object member beside a model it does not convert still checks the wire value: a required name must be there.
  {
    shape: 'a member narrows an inherited model property with an object that requires a name',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [ref('VisitBase'), object({ owner: object({ nick: text }, { required: ['nick'] }) })] } },
      { VisitBase: object({ owner: ref('Person') }), Person: object({ name: text }) },
    ),
    accepted: [],
    rejected: [{ m: { owner: { name: 'n' } } }, { m: { owner: { name: 'n', nick: 5 } } }],
  },
  // A covariant override: a derived component narrows an inherited model property to a model that extends it.
  {
    shape: 'a derived component narrows an inherited model property to a model that extends it',
    fixture: 'covariant-override',
    root: 'Derived',
    document: componentDocument('Derived', {
      Pet: object({ name: text }, { required: ['name'] }),
      Cat: { allOf: [ref('Pet'), object({ lives: { type: 'integer' } })] },
      Base: object({ pet: ref('Pet'), pets: { type: 'array', items: ref('Pet') } }),
      Derived: { allOf: [ref('Base'), object({ pet: ref('Cat'), pets: { type: 'array', items: ref('Cat') } })] },
    }),
    accepted: [{
      wire: { pet: { name: 'n', lives: 9 }, pets: [{ name: 'm', lives: 1 }] },
      model: {
        pet: { name: 'n', lives: 9 },
        pets: [{ name: 'm', lives: 1 }],
      },
    }],
    rejected: [{ pet: { name: 'n', lives: 'x' } }],
  },
  {
    shape: 'a derived component narrows an inherited model property to a model with two base refs',
    fixture: 'covariant-two-bases',
    root: 'Derived',
    document: componentDocument('Derived', {
      Pet: object({ name: text }, { required: ['name'] }),
      Named: object({ nick: text }),
      Cat: { allOf: [ref('Pet'), ref('Named'), object({ lives: { type: 'integer' } })] },
      Base: object({ named: ref('Named') }),
      Derived: { allOf: [ref('Base'), object({ named: ref('Cat') })] },
    }),
    accepted: [{
      wire: { named: { name: 'n', nick: 'k', lives: 9 } },
      model: { named: { name: 'n', nick: 'k', lives: 9 } },
    }],
    rejected: [{ named: { name: 'n', lives: 'x' } }],
  },
  // protects: T-456 a component that narrows an inherited union property to one variant decodes it as that variant
  {
    shape: 'a derived component narrows an inherited union property to one of its variants',
    root: 'Derived',
    document: petDocument(ref('Cat'), ['kind', 'lives']),
    accepted: [{ wire: { pet: { kind: 'cat', lives: 9 } }, model: { pet: { kind: 'cat', lives: 9 } } }],
    // The property decodes as Cat: a cat without lives and a dog both throw, though Pet accepts a dog.
    rejected: [{ pet: { kind: 'cat' } }, { pet: { kind: 'dog' } }],
  },
  // Arrays and tuples that convert alike combine by their items, so items that differ in null or required names agree.
  {
    shape: 'a derived component narrows an inherited array of nullable date-times to date-times',
    fixture: 'narrowed-items',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ stamps: { type: 'array', items: { type: ['string', 'null'], format: 'date-time' } } }),
      Derived: { allOf: [ref('Base'), object({ stamps: { type: 'array', items: dateTime } })] },
    }),
    accepted: [{ wire: { stamps: [AT] }, model: { stamps: [new Date(AT)] } }],
    rejected: [{ stamps: [null] }],
  },
  {
    shape: 'a derived component requires a name in the items of an inherited array',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ visits: { type: 'array', items: object({ a: dateTime }) } }),
      Derived: { allOf: [ref('Base'), object({ visits: { type: 'array', items: object({ a: dateTime }, { required: ['a'] }) } })] },
    }),
    accepted: [{ wire: { visits: [{ a: AT }] }, model: { visits: [{ a: new Date(AT) }] } }],
    rejected: [{ visits: [{}] }],
  },
  {
    shape: 'a derived component narrows an inherited tuple of a nullable date-time to a date-time',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ pair: { type: 'array', prefixItems: [{ type: ['string', 'null'], format: 'date-time' }], items: false } }),
      Derived: { allOf: [ref('Base'), object({ pair: { type: 'array', prefixItems: [dateTime], items: false } })] },
    }),
    accepted: [{ wire: { pair: [AT] }, model: { pair: [new Date(AT)] } }],
    rejected: [{ pair: [null] }],
  },
  // A lone model reference keeps the model; unevaluatedProperties: false beside it closes the model's names on the wire.
  {
    shape: 'a property that wraps one model $ref in allOf with unevaluatedProperties false',
    root: 'Visit',
    document: visitDocument(
      { owner: { allOf: [ref('Person')], unevaluatedProperties: false } },
      { Person: object({ name: text }) },
    ),
    accepted: [{ wire: { owner: { name: 'n' } }, model: { owner: { name: 'n' } } }],
    rejected: [{ owner: { name: 'n', z: 'q' } }],
  },
  // A component's own properties beside its allOf are its own names, and unevaluatedProperties: false keeps them.
  {
    shape: 'a component with own properties beside allOf and unevaluatedProperties false',
    fixture: 'unevaluated-sibling-properties',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ a: text }),
      Derived: { allOf: [ref('Base'), object({ c: text })], properties: { b: text }, unevaluatedProperties: false },
    }),
    accepted: [{ wire: { a: 'x', b: 'y', c: 'z' }, model: { a: 'x', b: 'y', c: 'z' } }],
    rejected: [{ a: 'x', b: 'y', z: 'q' }],
  },
  {
    shape: 'a component that is allOf [$ref Base] with unevaluatedProperties false',
    root: 'Derived',
    document: componentDocument('Derived', {
      Base: object({ a: text }),
      Derived: { allOf: [ref('Base')], unevaluatedProperties: false },
    }),
    accepted: [{ wire: { a: 'x' }, model: { a: 'x' } }],
    rejected: [{ a: 'x', z: 'q' }],
  },
  // A base beside a union in an allOf member (T-227): the value satisfies the base AND one variant.
  {
    shape: 'a field that is allOf [inline base, { oneOf of two inline objects }]',
    fixture: 'member-union-inline',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ id: text, at: dateTime }, { required: ['id'] }), { oneOf: [object({ kind: { const: 'a' }, a: text }, { required: ['kind', 'a'] }), object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] })] }] } }),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: 'x' } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: 'x' } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1' } }, { m: { kind: 'a', a: 'x' } }],
  },
  {
    shape: 'a field that is allOf [$ref Base, { oneOf of two inline objects }]',
    fixture: 'member-union-model',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [ref('Base'), { oneOf: [object({ kind: { const: 'a' }, a: text }, { required: ['kind', 'a'] }), object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] })] }] } },
      { Base: object({ id: text, at: dateTime }, { required: ['id'] }) },
    ),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: 'x' } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: 'x' } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1' } }, { m: { kind: 'a', a: 'x' } }],
  },
  {
    shape: 'a field that is allOf [$ref Base, { oneOf of two $ref models }]',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [ref('Base'), { oneOf: [ref('A'), ref('B')] }] } },
      {
        Base: object({ id: text, at: dateTime }, { required: ['id'] }),
        A: object({ kind: { const: 'a' }, a: dateTime }, { required: ['kind', 'a'] }),
        B: object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] }),
      },
    ),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: B } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: new Date(B) } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1' } }, { m: { kind: 'a', a: AT } }],
  },
  // The schema's own oneOf beside its allOf: the value satisfies the base AND one variant (T-92).
  {
    shape: 'a field that is allOf [inline base] beside its own oneOf of two inline objects',
    fixture: 'own-one-of',
    root: 'Visit',
    document: visitDocument({ m: { allOf: [object({ id: text, at: dateTime }, { required: ['id'] })], oneOf: [object({ kind: { const: 'a' }, a: text }, { required: ['kind', 'a'] }), object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] })] } }),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: 'x' } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: 'x' } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1' } }, { m: { kind: 'a', a: 'x' } }],
  },
  // A schema's oneOf and anyOf together, with no allOf: the value satisfies one variant of each (JSON Schema AND), as the validator reads them.
  // protects: T-554 a schema with both oneOf and anyOf keeps the anyOf in the type and the conversion
  {
    shape: 'a field that holds both a oneOf and an anyOf of inline objects, with no allOf',
    fixture: 'one-of-and-any-of',
    root: 'Visit',
    document: visitDocument({
      m: {
        oneOf: [object({ kind: { const: 'a' }, a: text }, { required: ['kind', 'a'] }), object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] })],
        anyOf: [object({ at: dateTime }, { required: ['at'] })],
      },
    }),
    accepted: [
      { wire: { m: { kind: 'a', a: 'p', at: AT } }, model: { m: { kind: 'a', a: 'p', at: new Date(AT) } } },
      { wire: { m: { kind: 'b', b: 'p', at: B } }, model: { m: { kind: 'b', b: 'p', at: new Date(B) } } },
    ],
    rejected: [{ m: { kind: 'a', a: 'p' } }, { m: { at: AT } }],
  },
  // A tagged oneOf beside an "at least one of" anyOf whose branches only require names (T-554): the required-only branches add no variant.
  {
    shape: 'a field that holds a tagged oneOf beside an anyOf of required-only branches',
    fixture: 'one-of-and-required-any-of',
    root: 'Visit',
    document: visitDocument({
      m: {
        properties: { email: text, phone: text },
        oneOf: [object({ kind: { const: 'a' }, a: text }, { required: ['kind', 'a'] }), object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] })],
        anyOf: [{ required: ['email'] }, { required: ['phone'] }],
      },
    }),
    accepted: [
      { wire: { m: { kind: 'a', a: 'p', email: 'e' } }, model: { m: { kind: 'a', a: 'p', email: 'e' } } },
      { wire: { m: { kind: 'b', b: 'p', phone: 'n' } }, model: { m: { kind: 'b', b: 'p', phone: 'n' } } },
      { wire: { m: { kind: 'a', a: 'p', email: 'e', phone: 'n' } }, model: { m: { kind: 'a', a: 'p', email: 'e', phone: 'n' } } },
    ],
    rejected: [{ m: { kind: 'a', a: 'p' } }, { m: { email: 'e' } }],
  },
  // Two oneOf unions in one allOf with no model, whose variants convert nothing: the value satisfies one variant of each (T-554).
  {
    shape: 'a field that is allOf of two oneOf unions of inline objects that convert nothing, with no model',
    fixture: 'two-one-of',
    root: 'Visit',
    document: visitDocument({
      m: {
        allOf: [
          { oneOf: [object({ kind: { const: 'a' }, a: text }, { required: ['kind', 'a'] }), object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] })] },
          { oneOf: [object({ mode: { const: 'x' }, x: text }, { required: ['mode', 'x'] }), object({ mode: { const: 'y' }, y: text }, { required: ['mode', 'y'] })] },
        ],
      },
    }),
    accepted: [
      { wire: { m: { kind: 'a', a: 'p', mode: 'x', x: 'q' } }, model: { m: { kind: 'a', a: 'p', mode: 'x', x: 'q' } } },
      { wire: { m: { kind: 'b', b: 'p', mode: 'y', y: 'q' } }, model: { m: { kind: 'b', b: 'p', mode: 'y', y: 'q' } } },
    ],
    rejected: [{ m: { kind: 'a', a: 'p' } }, { m: { mode: 'y', y: 'q' } }],
  },
  {
    shape: 'a field that is allOf [$ref Base] beside its own oneOf of two $ref models',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [ref('Base')], oneOf: [ref('A'), ref('B')] } },
      {
        Base: object({ id: text, at: dateTime }, { required: ['id'] }),
        A: object({ kind: { const: 'a' }, a: dateTime }, { required: ['kind', 'a'] }),
        B: object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] }),
      },
    ),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: B } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: new Date(B) } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1' } }, { m: { kind: 'a', a: AT } }],
  },
  {
    shape: 'a component that is allOf [$ref Base] beside its own oneOf of two $ref models, read through a field',
    root: 'Visit',
    document: visitDocument(
      { m: ref('Combo') },
      {
        Base: object({ id: text, at: dateTime }, { required: ['id'] }),
        A: object({ kind: { const: 'a' }, a: dateTime }, { required: ['kind', 'a'] }),
        B: object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] }),
        Combo: { allOf: [ref('Base')], oneOf: [ref('A'), ref('B')] },
      },
    ),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: B } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: new Date(B) } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1' } }, { m: { kind: 'a', a: AT } }],
  },
  // A component whose allOf holds a union member is an alias of the union of merged objects, not a class with no variant fields (T-220).
  {
    shape: 'a component that is allOf [$ref Base, { oneOf of two $ref models }], read as a type and through a field',
    fixture: 'component-member-union',
    root: 'Visit',
    document: visitDocument(
      { m: ref('Pet') },
      {
        Base: object({ id: text, at: dateTime }, { required: ['id'] }),
        A: object({ kind: { const: 'a' }, a: dateTime }, { required: ['kind', 'a'] }),
        B: object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] }),
        Pet: { allOf: [ref('Base'), { oneOf: [ref('A'), ref('B')] }] },
      },
    ),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: B } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: new Date(B) } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1' } }, { m: { kind: 'a', a: AT } }],
  },
  // A discriminator beside the union keeps the tag table (T-227): the kind property has no const, so only the table dispatches.
  {
    shape: 'a field that is allOf [$ref Base, { discriminated oneOf of two $ref models }]',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [ref('Base'), { oneOf: [ref('A'), ref('B')], discriminator: { propertyName: 'kind', mapping: { a: '#/components/schemas/A', b: '#/components/schemas/B' } } }] } },
      {
        Base: object({ id: text, at: dateTime }, { required: ['id'] }),
        A: object({ kind: text, a: dateTime }, { required: ['kind', 'a'] }),
        B: object({ kind: text, b: text }, { required: ['kind', 'b'] }),
      },
    ),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: B } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: new Date(B) } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1', kind: 'a' } }, { m: { id: '1', kind: 'b', a: AT } }, { m: { id: '1', kind: 'c' } }],
  },
  {
    shape: 'a field that is allOf [$ref Base] beside its own discriminated oneOf of two $ref models',
    root: 'Visit',
    document: visitDocument(
      { m: { allOf: [ref('Base')], oneOf: [ref('A'), ref('B')], discriminator: { propertyName: 'kind', mapping: { a: '#/components/schemas/A', b: '#/components/schemas/B' } } } },
      {
        Base: object({ id: text, at: dateTime }, { required: ['id'] }),
        A: object({ kind: text, a: dateTime }, { required: ['kind', 'a'] }),
        B: object({ kind: text, b: text }, { required: ['kind', 'b'] }),
      },
    ),
    accepted: [
      { wire: { m: { id: '1', at: AT, kind: 'a', a: B } }, model: { m: { id: '1', at: new Date(AT), kind: 'a', a: new Date(B) } } },
      { wire: { m: { id: '1', kind: 'b', b: 'y' } }, model: { m: { id: '1', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1', kind: 'a' } }, { m: { id: '1', kind: 'b', a: AT } }, { m: { id: '1', kind: 'c' } }],
  },
  // Keywords beside the oneOf in the union member are one more part of every variant (T-227).
  {
    shape: 'a field that is allOf [inline base, { properties and required beside a oneOf }]',
    root: 'Visit',
    document: visitDocument({
      m: {
        allOf: [
          object({ id: text }, { required: ['id'] }),
          { properties: { note: text }, required: ['note'], oneOf: [object({ kind: { const: 'a' }, a: dateTime }, { required: ['kind', 'a'] }), object({ kind: { const: 'b' }, b: text }, { required: ['kind', 'b'] })] },
        ],
      },
    }),
    accepted: [
      { wire: { m: { id: '1', note: 'n', kind: 'a', a: AT } }, model: { m: { id: '1', note: 'n', kind: 'a', a: new Date(AT) } } },
      { wire: { m: { id: '1', note: 'n', kind: 'b', b: 'y' } }, model: { m: { id: '1', note: 'n', kind: 'b', b: 'y' } } },
    ],
    rejected: [{ m: { id: '1', kind: 'b', b: 'y' } }, { m: { id: '1', note: 'n' } }],
  },
];

interface Built {
  readonly output: string;
  /** The composition warnings of generation, as `code: message`. */
  readonly warnings: readonly string[];
  /** The client's reading of the row's root as a response body and its writing as a request body. */
  readonly codec: SdkBodyCodec;
}

/** The operations the builder adds beside the document's own: one that answers the root and one that takes it as a request body. */
function withRootOperations(document: Record<string, unknown>, root: string): Record<string, unknown> {
  const schema = ref(root);
  const paths = requireRecord(document.paths, 'paths');
  return {
    ...document,
    paths: {
      ...paths,
      '/root-in': { post: { operationId: 'putRoot', requestBody: { required: true, content: { 'application/json': { schema } } }, responses: { 204: { description: 'none' } } } },
    },
  };
}

const scope = fileFixtureScope();

function builder(row: Row, validation: boolean): () => Promise<Built> {
  return onceShared(async () => {
    const output = path.join(createFixtureProject(scope, 'golem-composition-agreement-'), 'sdk');
    const result = await generateMaterializedSdk(withRootOperations(row.document, row.root), {
      output,
      name: 'Composition',
      profile: { mobx: false, validation, allowAny: false },
    });
    compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
    return {
      output,
      warnings: (result.diagnostics ?? []).filter(({ code }) => code.startsWith('OPENAPI_COMPOSITION_'))
        .map(({ code, message }) => `${code}: ${message}`),
      codec: await sdkBodyCodec(output, 'Composition', { read: 'getRoot', write: 'putRoot' }),
    };
  });
}

/** Fields and wire values count an absent optional property and one set to undefined alike, as JSON does. */
function fieldsOf(model: object): Fields {
  return withoutUndefined({ ...model }) as Fields;
}

/** The value without undefined fields. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (typeof value !== 'object' || value === null || value instanceof Date) return value;
  const fields = Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined).map(([name, field]) => [name, withoutUndefined(field)]),
  );
  return Object.assign(Object.create(Object.getPrototypeOf(value)), fields);
}

/** A failure names the input that caused it. */
async function forInput(wire: Wire, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`input ${JSON.stringify(wire)}: ${reason}`, { cause: error });
  }
}

/** The codec reads and writes the same fields for each accepted input. */
async function assertPathsAgree(built: Built, accepted: readonly Accepted[]): Promise<void> {
  for (const { wire, model: expected } of accepted) {
    const model = withoutUndefined(expected);
    await forInput(wire, async () => {
      const decoded = await built.codec.decode(wire) as Fields;
      assert.deepEqual(fieldsOf(decoded), model, 'the client decodes the response');
      assert.deepEqual(withoutUndefined(await built.codec.encode(decoded)), wire, 'the client encodes the request');
    });
  }
}

/** The request check accepts each decoded accepted input and the client rejects each rejected input as a response. */
async function assertValidatorJudges(built: Built, row: Row): Promise<void> {
  for (const { wire } of row.accepted) {
    await forInput(wire, async () => {
      const decoded = await built.codec.decode(wire, { validate: false });
      await assert.doesNotReject(built.codec.encode(decoded), 'the request check accepts the decoded value');
    });
  }
  for (const wire of row.rejected) {
    await forInput(wire, () => assertCodecRejects(built, wire));
  }
}

/** A model validator of the generated module: `validate_<Model>_<hash>` with the plane of its schema. */
const MODEL_VALIDATOR = /^validate_(\w+?)_[0-9a-f]{8}(?:_wire|_model_only|_wire_only)?$/;

/**
 * Each model root of the generated validators module has a fast check (`is_X`) on every plane. Each fast check gives the
 * answer of its validator (`validate_X`) on every input of the row, accepted and rejected (spec 5.1 rule 1).
 */
async function assertFastChecksAgree(built: Built, row: Row): Promise<void> {
  const validators = requireRecord(await import(pathToFileURL(path.join(built.output, 'dist/validators.generated.js')).href), `generated ${row.shape} validators`);
  const inputs: readonly unknown[] = [...row.accepted.map(({ wire }) => wire), ...row.rejected];
  const roots = Object.keys(validators).flatMap(name => {
    const match = MODEL_VALIDATOR.exec(name);
    if (match === null) return [];
    return [{ model: match[1], validate: validators[name], isValid: validators[`is_${name.slice('validate_'.length)}`] }];
  });
  // A model root exists when the client converts the model; a row that converts nothing has only operation roots, which have no fast check.
  const converts = row.accepted.some(({ wire, model }) => !isDeepStrictEqual(wire, model));
  if (converts) assert.ok(roots.some(({ model }) => model === row.root), `the generated validators have the root ${row.root}`);
  assert.deepEqual(roots.filter(({ isValid }) => typeof isValid !== 'function').map(({ model }) => model), [], 'every model root has a fast check');
  const disagreeing = roots.flatMap(({ model, validate, isValid }) => typeof isValid !== 'function' || typeof validate !== 'function' ? [] : inputs
    .filter(input => isValid(input) !== (validate(input, true).length === 0))
    .map(input => ({ model, input })));
  assert.deepEqual(disagreeing, []);
}

async function assertCodecRejects(built: Built, wire: Wire): Promise<void> {
  await assert.rejects(
    built.codec.decode(wire),
    (error: unknown): true => {
      assert.ok(error instanceof LibError, 'codec rejects the input');
      assert.equal(error.kind, LibErrorKind.Validation);
      return true;
    },
  );
}

for (const row of rows) {
  const checked = builder(row, true);
  const unchecked = builder(row, false);

  const fixture = row.fixture;
  if (fixture !== undefined) {
    // The fixtures state the converted type of a row: a Date where the wire holds a date-time.
    test(`${row.shape}: the generated type`, async () => {
      const { output } = await checked();
      copyFixtureFile(output, `openapi/composition/${fixture}-types.ts`, 'row-types.ts');
      compileGeneratedSdk(output, [path.join(output, 'row-types.ts')], { strict: true, skipLibCheck: true, noEmit: true });
    });
  }

  test(`${row.shape}: validation on`, async () => {
    const built = await checked();
    const warnings = row.warnings ?? [];
    assert.equal(built.warnings.length, warnings.length, `composition warnings: ${JSON.stringify(built.warnings)}`);
    warnings.forEach((warning, index) => assert.match(built.warnings[index] ?? '', warning));
    await assertPathsAgree(built, row.accepted);
    await assertValidatorJudges(built, row);
    await assertFastChecksAgree(built, row);
  });

  if (row.accepted.length > 0) {
    test(`${row.shape}: validation off`, async () => {
      await assertPathsAgree(await unchecked(), row.accepted);
    });
  }
}

const untaggedDateUnion = { allOf: [object({ id: text }), { oneOf: [object({ at: dateTime }), object({ on: dateTime })] }] };
const dateTimeAndModel = { allOf: [dateTime, ref('Thing')] };
const inlineObject = (m: Record<string, unknown>): Record<string, unknown> => object({ m }, { required: ['m'] });
const inlineBody = (m: Record<string, unknown>): Record<string, unknown> => ({
  required: true,
  content: { 'application/json': { schema: inlineObject(m) } },
});

/** One POST operation with inline bodies: the document of `operation` replaces the default request body and response. */
function operationDocument(operation: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Composition', version: '1' },
    paths: {
      '/visits': {
        post: { operationId: 'postVisit', responses: { 204: { description: 'none' } }, ...operation },
      },
    },
    components: { schemas: { Thing: object({ n: text }) } },
  };
}

/** `Derived` extends `Base`, whose `pet` is the union `Pet` of `Cat` and `Dog`; `Derived` narrows `pet` to `narrowed`. */
function petDocument(narrowed: Record<string, unknown>, catRequired: readonly string[] = ['kind']): Record<string, unknown> {
  const kinds = (tag: string, own: Record<string, unknown>, required: readonly string[] = ['kind']): Record<string, unknown> =>
    ({ allOf: [ref('Animal'), object({ kind: { const: tag }, ...own }, { required: [...required] })] });
  return componentDocument('Derived', {
    Animal: object({ kind: text }, { required: ['kind'] }),
    Cat: kinds('cat', { lives: { type: 'integer' } }, catRequired),
    Dog: kinds('dog', { bark: { type: 'boolean' } }),
    Bird: kinds('bird', { wings: { type: 'integer' } }),
    Pet: {
      oneOf: [ref('Cat'), ref('Dog')],
      discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } },
    },
    Base: object({ pet: ref('Pet') }, { required: ['pet'] }),
    Derived: { allOf: [ref('Base'), object({ pet: narrowed })] },
  });
}

/**
 * Shapes that stop generation: no object satisfies them, or two members convert one value in two ways. The error names
 * its code, the schema pointer and the fix.
 */
const stopped: readonly { readonly shape: string; readonly error: RegExp; readonly document: Record<string, unknown> }[] = [
  {
    shape: 'closed base and a component with a required own property',
    error: /schema "Derived" at #\/components\/schemas\/Derived(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*"b".*Remove additionalProperties: false/,
    document: componentDocument('Derived', {
      Base: { type: 'object', additionalProperties: false, properties: { a: text } },
      Derived: { allOf: [ref('Base'), object({ b: dateTime }, { required: ['b'] })] },
    }),
  },
  {
    shape: 'closed base and a component that requires an own property beside its allOf',
    error: /schema "Derived" at #\/components\/schemas\/Derived(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*"b"/,
    document: componentDocument('Derived', {
      Base: { type: 'object', additionalProperties: false, properties: { a: text } },
      Derived: { allOf: [ref('Base')], properties: { b: text }, required: ['b'] },
    }),
  },
  {
    shape: 'a closed derived member and a required base property',
    error: /schema "Derived" at #\/components\/schemas\/Derived(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*"a".*allOf member \d sets additionalProperties: false\. Replace it with unevaluatedProperties: false/,
    document: componentDocument('Derived', {
      Base: object({ a: text }, { required: ['a'] }),
      Derived: { allOf: [ref('Base'), { type: 'object', additionalProperties: false, properties: { b: text } }] },
    }),
  },
  {
    shape: 'members that give a required property disjoint types',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*"a" has no value that every member accepts/,
    document: visitDocument({ m: { allOf: [object({ a: text }, { required: ['a'] }), object({ a: { type: 'number' } })] } }),
  },
  // protects: T-279 a required property that members type as a Date and as a model stops as unsatisfiable, naming the property
  {
    shape: 'members that type a required property as a Date and as a model',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*the required property "x" has no value that every member accepts/,
    document: visitDocument({ m: { allOf: [object({ x: dateTime }, { required: ['x'] }), object({ x: ref('M') })] } }, { M: object({ n: text }) }),
  },
  // protects: T-279 a union whose variants share one JSON type is disjoint from a date-time, as a single model is
  {
    shape: 'members that type a required property as a Date and as a union of models',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*the required property "x" has no value that every member accepts/,
    document: visitDocument(
      { m: { allOf: [object({ x: dateTime }, { required: ['x'] }), object({ x: { oneOf: [ref('M'), ref('N')] } })] } },
      { M: object({ n: text }), N: object({ k: text }) },
    ),
  },
  // protects: T-279 members that convert one property in two ways but share a JSON type keep the conversion conflict
  {
    shape: 'members that convert one property to two different models',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_CONVERSION_CONFLICT: /,
    document: visitDocument({ m: { allOf: [object({ x: ref('M') }), object({ x: ref('N') })] } }, { M: object({ n: text }), N: object({ k: text }) }),
  },
  {
    shape: 'a model base beside a union with a variant that is no object',
    error: /schema "Visit" at #\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_CONVERSION_CONFLICT: .*model beside a union.*plain object schemas/,
    document: visitDocument({ m: { allOf: [ref('Base'), { oneOf: [object({ kind: { const: 'a' }, a: text }, { required: ['kind', 'a'] }), text] }] } }, { Base: object({ id: text }, { required: ['id'] }) }),
  },
  // protects: T-554 a oneOf and an anyOf that each have several object variants stop with a coded error, not code that fails validation
  {
    shape: 'a oneOf and an anyOf that each have two object variants',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_CONVERSION_CONFLICT: .*two unions with several object variants each/,
    document: visitDocument({
      m: {
        oneOf: [object({ kind: { const: 'a' }, at: dateTime }), object({ kind: { const: 'b' } })],
        anyOf: [object({ mode: { const: 'x' } }), object({ mode: { const: 'y' } })],
      },
    }),
  },
  // protects: T-554 two oneOf unions in one allOf with no model stop when a variant holds a Date, as one oneOf and one anyOf do
  {
    shape: 'an allOf of two oneOf unions with two object variants each, one of them holding a Date',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_CONVERSION_CONFLICT: .*two unions with several object variants each/,
    document: visitDocument({
      m: {
        allOf: [
          { oneOf: [object({ kind: { const: 'a' }, at: dateTime }), object({ kind: { const: 'b' } })] },
          { oneOf: [object({ mode: { const: 'x' } }), object({ mode: { const: 'y' } })] },
        ],
      },
    }),
  },
  {
    shape: 'a model base beside two unions',
    error: /schema "Visit" at #\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_CONVERSION_CONFLICT: .*model beside a union.*plain object schemas/,
    document: visitDocument({ m: { allOf: [ref('Base'), { oneOf: [object({ kind: { const: 'a' } }), object({ kind: { const: 'b' } })] }, { oneOf: [object({ mode: { const: 'x' } }), object({ mode: { const: 'y' } })] }] } }, { Base: object({ id: text }, { required: ['id'] }) }),
  },
  // protects: T-120 members that admit no common value stop as unsatisfiable, not as a conversion conflict
  {
    shape: 'members that give the value a Date and a model',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*string.*object/,
    document: visitDocument({ m: { allOf: [dateTime, ref('M')] } }, { M: object({ n: text }) }),
  },
  {
    shape: 'members that give the value a string and a number',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*string.*number/,
    document: visitDocument({ m: { allOf: [text, { type: 'number' }] } }),
  },
  {
    shape: 'members that give a required property a model and a string',
    error: /#\/components\/schemas\/Visit\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*"x" has no value that every member accepts/,
    document: visitDocument(
      { m: { allOf: [object({ x: ref('M') }, { required: ['x'] }), object({ x: text })] } },
      { M: object({ n: text }) },
    ),
  },
  {
    shape: 'an array component whose items type a required property as a Date and as a model',
    error: /schema "Events" at #\/components\/schemas\/Events\/items(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*"x"/,
    document: visitDocument(
      { e: ref('Events') },
      { Events: { type: 'array', items: { allOf: [object({ x: dateTime }, { required: ['x'] }), object({ x: ref('M') })] } }, M: object({ n: text }) },
    ),
  },
  {
    shape: 'array items whose members type a required property as a Date and as a model',
    error: /#\/components\/schemas\/Visit\/properties\/e\/items(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*"x"/,
    document: visitDocument(
      { e: { type: 'array', items: { allOf: [object({ x: dateTime }, { required: ['x'] }), object({ x: ref('M') })] } } },
      { M: object({ n: text }) },
    ),
  },
  // protects: T-279 array items whose members convert one property to two different models keep the conversion conflict
  {
    shape: 'array items whose members convert a required property to two different models',
    error: /#\/components\/schemas\/Visit\/properties\/e\/items(?=[ :]).*OPENAPI_COMPOSITION_CONVERSION_CONFLICT: /,
    document: visitDocument(
      { e: { type: 'array', items: { allOf: [object({ x: ref('M') }, { required: ['x'] }), object({ x: ref('N') })] } } },
      { M: object({ n: text }), N: object({ k: text }) },
    ),
  },
  // protects: T-456 a component that narrows a union property to a model outside the union still stops with the conflict
  {
    shape: 'a component that narrows a union property to a model that is not a variant',
    error: /schema "Derived" at #\/components\/schemas\/Derived(?=[ :]).*OPENAPI_COMPOSITION_CONVERSION_CONFLICT: /,
    document: petDocument(ref('Bird')),
  },
  {
    shape: 'an inline request body whose members give the value a Date and a model',
    error: /schema of request body application\/json of operation "postVisit" at #\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*string.*object/,
    document: operationDocument({ requestBody: inlineBody(dateTimeAndModel) }),
  },
  // protects: T-650 a union of untagged object variants in a request body or a query parameter stops with the discriminator code, as in a response
  {
    shape: 'an inline request body that is an allOf of an object and a union of untagged object variants holding Dates',
    error: /schema of request body application\/json of operation "postVisit" at #(?=[ :]).*OPENAPI_UNION_DISCRIMINATOR_MISSING/,
    document: operationDocument({ requestBody: inlineBody(untaggedDateUnion) }),
  },
  {
    shape: 'a query parameter that is an allOf of an object and a union of untagged object variants holding Dates',
    error: /schema of query parameter "q" of operation "postVisit" at #(?=[ :]).*OPENAPI_UNION_DISCRIMINATOR_MISSING/,
    document: operationDocument({ parameters: [{ name: 'q', in: 'query', schema: untaggedDateUnion }] }),
  },
  {
    shape: 'an inline response body whose members give the value a Date and a model',
    error: /schema of 200 response application\/json of operation "postVisit" at #\/properties\/m(?=[ :]).*OPENAPI_COMPOSITION_UNSATISFIABLE: .*string.*object/,
    document: operationDocument({ responses: { 200: { description: 'ok', content: { 'application/json': { schema: inlineObject(dateTimeAndModel) } } } } }),
  },
];

for (const { shape, error: expected, document } of stopped) {
  test(`${shape}: generation stops with a coded error`, async t => {
    const output = path.join(createFixtureProject(t, 'golem-composition-stopped-'), 'sdk');
    await assert.rejects(
      generateMaterializedSdk(document, { output, name: 'Composition', profile: { mobx: false, validation: true, allowAny: false } }),
      (error: unknown): true => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        return true;
      },
    );
  });
}

// protects: T-385 a variant still narrows the union that selects it, as it did when the variant extended the union class
test('an inline response narrows an inherited oneOf property to one of its variants', async t => {
  const animal = object({ kind: text }, { required: ['kind'] });
  const variant = (tag: string, own: Record<string, unknown>): Record<string, unknown> =>
    ({ allOf: [ref('Animal'), object({ kind: { const: tag }, ...own }, { required: ['kind'] })] });
  const document = componentDocument('Base', {
    Animal: animal,
    Cat: variant('cat', { lives: { type: 'integer' } }),
    Dog: variant('dog', { bark: { type: 'boolean' } }),
    Pet: {
      oneOf: [ref('Cat'), ref('Dog')],
      discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } },
    },
    Base: object({ pet: ref('Pet'), pets: { type: 'array', items: ref('Pet') } }),
  });
  const paths = requireRecord(document.paths, 'paths');
  paths['/root'] = { get: { operationId: 'getRoot', responses: { 200: { description: 'ok', content: { 'application/json': {
    schema: { allOf: [ref('Base'), object({ pet: ref('Cat'), pets: { type: 'array', items: ref('Cat') } })] },
  } } } } } };
  const output = path.join(createFixtureProject(t, 'golem-composition-variant-'), 'sdk');
  const result = await generateMaterializedSdk(document, { output, name: 'Composition', profile: { mobx: false, validation: true, allowAny: false } });
  assert.deepEqual((result.diagnostics ?? []).map(diagnostic => diagnostic.code), []);
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
});

/** Generates the SDK with validation on, asserts that generation gave no diagnostic, and compiles the result. */
async function generateCompiledSdk(document: Record<string, unknown>, output: string): Promise<void> {
  const result = await generateMaterializedSdk(document, { output, name: 'Composition', profile: { mobx: false, validation: true, allowAny: false } });
  assert.deepEqual((result.diagnostics ?? []).map(diagnostic => diagnostic.code), []);
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
}

// protects: T-456 a component that narrows an inherited union property to one of its variants generates and round-trips its wire form
test('a component narrows an inherited union property to one of its variants', async t => {
  const output = path.join(createFixtureProject(t, 'golem-composition-narrowed-'), 'sdk');
  await generateCompiledSdk(withRootOperations(petDocument(ref('Cat')), 'Derived'), output);
  const codec = await sdkBodyCodec(output, 'Composition', { read: 'getRoot', write: 'putRoot' });
  const decoded = await codec.decode({ pet: { kind: 'cat', lives: 9 } }, { validate: false });
  assert.deepEqual(withoutUndefined(await codec.encode(decoded)), { pet: { kind: 'cat', lives: 9 } });
});

// protects: T-650 the composition check reads a request body with the decode conversion, so a oneOf of one $ref with no null and a readOnly property still generate as before
test('a request body of allOf with a oneOf of one reference and a readOnly property generates', async t => {
  const document = componentDocument('Pet', { Pet: object({ name: text }, { required: ['name'] }) });
  requireRecord(document.paths, 'paths')['/pets'] = { post: {
    operationId: 'addPet',
    requestBody: { required: true, content: { 'application/json': { schema: { allOf: [
      object({ pet: { oneOf: [ref('Pet')] }, id: { type: 'string', readOnly: true } }, { required: ['pet', 'id'] }),
      object({ note: text }),
    ] } } } },
    responses: { 200: { description: 'ok' } },
  } };
  const output = path.join(createFixtureProject(t, 'golem-composition-request-'), 'sdk');
  await generateCompiledSdk(document, output);
});

const bothKeywords = {
  oneOf: [object({ kind: { const: 'a' }, code: { type: 'string', format: 'no-such-format' } }, { required: ['kind', 'code'] }), object({ kind: { const: 'b' } }, { required: ['kind'] })],
  anyOf: [object({ at: dateTime }, { required: ['at'] })],
};

// protects: T-554 a diagnostic inside a branch of a schema with both keywords names the place in the user's document
test('a diagnostic inside a oneOf branch of a schema with both keywords names the user path', async t => {
  const root = createFixtureProject(t, 'golem-composition-path-');
  const input = path.join(root, 'openapi.json');
  writeFileSync(input, JSON.stringify(visitDocument({ m: bothKeywords })));
  const result = await generate({ input, output: path.join(root, 'sdk'), name: 'Composition', profile: { mobx: false, validation: true, allowAny: false } });
  const messages = (result.diagnostics ?? []).map(diagnostic => diagnostic.message);
  assert.deepEqual(messages.filter(message => message.includes('/allOf/')), []);
  assert.equal(messages.filter(message => message.includes('#/components/schemas/Visit/properties/m/oneOf/0/properties/code/format: the format "no-such-format"')).length, 1, JSON.stringify(messages));
});
