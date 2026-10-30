import assert from 'node:assert/strict';
import test from 'node:test';

import {
  convertModelField,
  convertModelItems,
  convertModelTupleItems,
  defineModelProperty,
  deserializeDate,
  withDiscriminatorValue,
} from '@exprtlabs/golem/internal/model-runtime';
import {
  code,
  emitModelFromInit,
  emitModelFromJSON,
  identifier,
  render,
  type FromJsonModelResolver,
  type ModelConversionDescriptor,
  type SerdeResolver,
} from '@exprtlabs/golem/internal/emitter';

import { DATE_FIELD, DATE_SERDE } from './support/date-field.js';
import { runModule } from './support/run-module.js';

type CompiledConversion = (value: unknown) => unknown;

function objectDescriptor(
  properties: Readonly<Record<string, ModelConversionDescriptor>>,
): ModelConversionDescriptor {
  return {
    kind: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** An object member of an intersection: it lists some names and leaves the others to its siblings (strict JSON Schema). */
function openObjectDescriptor(
  properties: Readonly<Record<string, ModelConversionDescriptor>>,
): ModelConversionDescriptor {
  return { kind: 'object', properties, required: Object.keys(properties), additionalProperties: true };
}

function literal(value: string | number | boolean): ModelConversionDescriptor {
  return { kind: 'literal', value };
}

function compileConversion(
  expression: string,
  bindings: Readonly<Record<string, unknown>>,
): CompiledConversion {
  const source = [
    'function run(value: unknown): unknown {',
    `  return (${expression});`,
    '}',
  ].join('\n');
  const { run } = runModule(source, bindings, { exports: ['run'] });
  if (typeof run !== 'function') throw new TypeError('Generated conversion did not export run.');
  return (value: unknown): unknown => (run as (input: unknown) => unknown)(value);
}

class ChildModel {
  public static fromJsonCalls = 0;
  public static fromInitCalls = 0;

  public constructor(public readonly name: string) {}

  public static fromJSON(value: unknown): ChildModel {
    ChildModel.fromJsonCalls += 1;
    if (value === null || typeof value !== 'object') throw new TypeError('Child must be an object.');
    return new ChildModel(String((value as Record<string, unknown>).name));
  }

  public static fromInit(value: unknown): ChildModel {
    ChildModel.fromInitCalls += 1;
    if (value instanceof ChildModel) return value;
    return ChildModel.fromJSON(value);
  }
}

const fromChild: FromJsonModelResolver = {
  className: identifier('ChildModel'),
  decode: (value) => code`decodeChildModel(ChildModel, ${value})`,
  fromInit: (value) => code`ChildModel.fromInit(${value})`,
};

let decodeCalls = 0;

function decodeToken(value: unknown): number {
  decodeCalls += 1;
  const text = String(value);
  if (!text.startsWith('token:')) throw new TypeError('Invalid token.');
  return Number(text.slice('token:'.length));
}

const serde: SerdeResolver = {
  deserialize: (serde, value) => serde.id === DATE_FIELD.serde?.id ? DATE_SERDE.deserialize(serde, value) : code`decodeToken(${value})`,
  serialize: (_serde, value) => value,
};

const bindings: Readonly<Record<string, unknown>> = {
  convertModelField,
  convertModelItems,
  convertModelTupleItems,
  defineModelProperty,
  ChildModel,
  decodeChildModel: (_constructor: unknown, value: unknown) =>
    value instanceof ChildModel ? value : ChildModel.fromJSON(value),
  decodeToken,
  deserializeDate,
  withDiscriminatorValue,
};

function resetCounters(): void {
  ChildModel.fromJsonCalls = 0;
  ChildModel.fromInitCalls = 0;
  decodeCalls = 0;
}

/** The wire-to-model conversion that the emitter writes for `descriptor`, compiled against the shared bindings. */
function compileFromJSON(descriptor: ModelConversionDescriptor): CompiledConversion {
  return compileConversion(
    render(emitModelFromJSON(descriptor, identifier('value'), () => fromChild, serde)),
    bindings,
  );
}

test('intersection conversion merges object fields and runs overlapping conversions once', () => {
  resetCounters();
  const child = { kind: 'generated-model', id: 'child' } as const;
  const token = {
    kind: 'number',
    serde: { id: 'token', wire: { kind: 'string' } },
  } as const;
  const descriptor: ModelConversionDescriptor = {
    kind: 'intersection',
    variants: [
      openObjectDescriptor({ when: DATE_FIELD, child, token }),
      openObjectDescriptor({ when: DATE_FIELD, token, label: { kind: 'string' } }),
    ],
  };

  const fromJSON = compileFromJSON(descriptor);

  const decoded = fromJSON({
    when: '2025-01-02T03:04:05.000Z',
    child: { name: 'nested' },
    token: 'token:7',
    label: 'intersection',
  }) as { when: unknown; child: unknown; token: unknown; label: string };
  assert.ok(decoded.when instanceof Date);
  assert.ok(decoded.child instanceof ChildModel);
  assert.equal(decoded.token, 7);
  assert.equal(decoded.label, 'intersection');
  assert.equal(decodeCalls, 1, 'an overlapping serde field is decoded once');
  assert.equal(ChildModel.fromJsonCalls, 1);
});

test('intersection and nullable fromInit preserve domain Date values while constructing nested models', () => {
  resetCounters();
  const domainDate = new Date('2025-02-03T04:05:06.000Z');
  const descriptor: ModelConversionDescriptor = {
    kind: 'intersection',
    variants: [
      openObjectDescriptor({ when: DATE_FIELD, child: { kind: 'generated-model', id: 'child' } }),
      openObjectDescriptor({ when: DATE_FIELD, token: { kind: 'number', serde: { id: 'token', wire: { kind: 'string' } } } }),
    ],
  };
  const fromInit = compileConversion(
    render(emitModelFromInit(descriptor, identifier('value'), () => fromChild)),
    bindings,
  );
  const nullableDate = compileConversion(
    render(emitModelFromInit({ kind: 'union', variants: [DATE_FIELD, { kind: 'null' }] }, identifier('value'), () => fromChild)),
    bindings,
  );

  const initialized = fromInit({
    when: domainDate,
    child: { name: 'initializer' },
    token: 8,
  }) as { when: unknown; child: unknown; token: unknown };
  assert.strictEqual(initialized.when, domainDate);
  assert.ok(initialized.child instanceof ChildModel);
  assert.equal(initialized.token, 8);
  assert.equal(decodeCalls, 0, 'fromInit does not call a wire deserializer');
  assert.equal(ChildModel.fromInitCalls, 1);
  assert.strictEqual(nullableDate(domainDate), domainDate);
  assert.equal(nullableDate(null), null);
});

test('discriminated plain object unions convert only the selected branch', () => {
  resetCounters();
  const descriptor: ModelConversionDescriptor = {
    kind: 'union',
    variants: [
      objectDescriptor({
        kind: literal('token'),
        when: DATE_FIELD,
        token: { kind: 'number', serde: { id: 'token', wire: { kind: 'string' } } },
      }),
      objectDescriptor({
        kind: literal('child'),
        when: DATE_FIELD,
        child: { kind: 'generated-model', id: 'child' },
      }),
    ],
    discriminator: { propertyName: 'kind', variants: [{ values: ['token'] }, { values: ['child'] }] },
  };
  const fromJSON = compileFromJSON(descriptor);

  const tokenBranch = fromJSON({
    kind: 'token',
    when: '2025-03-04T05:06:07.000Z',
    token: 'token:11',
  }) as { kind: string; when: unknown; token: unknown };
  assert.equal(tokenBranch.kind, 'token');
  assert.ok(tokenBranch.when instanceof Date);
  assert.equal(tokenBranch.token, 11);
  assert.equal(decodeCalls, 1);
  assert.equal(ChildModel.fromJsonCalls, 0, 'the unselected child branch is never constructed');

  const childBranch = fromJSON({
    kind: 'child',
    when: '2025-03-04T05:06:07.000Z',
    child: { name: 'branch' },
  }) as { kind: string; when: unknown; child: unknown };
  assert.equal(childBranch.kind, 'child');
  assert.ok(childBranch.when instanceof Date);
  assert.ok(childBranch.child instanceof ChildModel);
  assert.equal(decodeCalls, 1, 'the token codec is not probed for the child branch');
  assert.equal(ChildModel.fromJsonCalls, 1);
});

test('ambiguous union conversions fail generation instead of probing codecs', () => {
  const token: ModelConversionDescriptor = { kind: 'number', serde: { id: 'token', wire: { kind: 'string' } } };
  const cases: readonly { name: string; descriptor: ModelConversionDescriptor; message: RegExp }[] = [
    {
      name: 'object variants with the same discriminator',
      descriptor: {
        kind: 'union',
        variants: [
          objectDescriptor({ when: DATE_FIELD }),
          objectDescriptor({ when: DATE_FIELD }),
        ],
      },
      message: /unique|required literal discriminator|ambiguous/i,
    },
    {
      // `Date | Date[]` converts by its wire value (T-320); a plain string beside the Date makes the string ambiguous.
      name: 'date beside a string and an array of strings',
      descriptor: {
        kind: 'union',
        variants: [
          DATE_FIELD,
          { kind: 'string' },
          { kind: 'array', item: { kind: 'string' } },
        ],
      },
      message: /ambiguous conversions/i,
    },
    {
      name: 'converting scalar beside a number and an array of the same scalar',
      descriptor: {
        kind: 'union',
        variants: [token, { kind: 'number' }, { kind: 'array', item: token }],
      },
      message: /ambiguous conversions/i,
    },
    {
      name: 'converting scalar beside a string and an array of the same scalar',
      descriptor: {
        kind: 'union',
        variants: [token, { kind: 'string' }, { kind: 'array', item: token }],
      },
      message: /ambiguous conversions/i,
    },
    {
      name: 'converting scalar beside a string and a tuple of the same scalar',
      descriptor: {
        kind: 'union',
        variants: [token, { kind: 'string' }, { kind: 'tuple', items: [token] }],
      },
      message: /ambiguous conversions/i,
    },
  ];
  for (const { name, descriptor, message } of cases) {
    assert.throws(() => render(emitModelFromJSON(descriptor, identifier('value'), () => fromChild, serde)), message, name);
  }
});

test('scalar-or-array unions convert the scalar and the array items without doubling Array.isArray', () => {
  const status: ModelConversionDescriptor = {
    kind: 'union',
    variants: [
      { kind: 'literal', value: 'paid' },
      { kind: 'literal', value: 'pending' },
      { kind: 'array', item: { kind: 'union', variants: [{ kind: 'literal', value: 'paid' }, { kind: 'literal', value: 'pending' }] } },
    ],
  };
  assert.equal(render(emitModelFromJSON(status, identifier('value'), () => fromChild)), 'value', 'identity unions emit no Array.isArray map');
  assert.doesNotMatch(render(emitModelFromJSON(status, identifier('value'), () => fromChild)), /Array\.isArray/);
  resetCounters();
  const token: ModelConversionDescriptor = {
    kind: 'number',
    serde: { id: 'token', wire: { kind: 'string' } },
  };
  const descriptor: ModelConversionDescriptor = {
    kind: 'union',
    variants: [
      token,
      { kind: 'array', item: token },
    ],
  };
  const source = render(emitModelFromJSON(descriptor, identifier('value'), () => fromChild, serde));
  assert.match(source, /Array\.isArray\(value\)/, 'the scalar-or-array union branches on Array.isArray');
  assert.equal(
    source.match(/Array\.isArray/g)?.length,
    1,
    'the union tests Array.isArray once, not once per variant (no doubled check)',
  );
  assert.doesNotMatch(
    source,
    /\.map\(\(item\) => item\)/,
    'the array branch does not wrap items in a redundant identity map',
  );
  const fromJSON = compileConversion(source, bindings);
  assert.equal(fromJSON('token:4'), 4);
  assert.deepEqual(fromJSON(['token:4', 'token:5']), [4, 5]);
  assert.equal(decodeCalls, 3);
});
