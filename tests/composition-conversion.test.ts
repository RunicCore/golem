import assert from 'node:assert/strict';
import test from 'node:test';
import { transformSync } from 'esbuild';

import { convertModelField, convertModelItems, convertModelTupleItems, deserializeDate, serializeDate, withDiscriminatorValue } from '@exprtlabs/golem/conversion';
import {
  emitModelFromInit,
  emitModelFromJSON,
  emitModelToJSON,
  type FromJsonModelResolver,
  type ModelConversionDescriptor,
  type SerdeResolver,
  type ToJsonModelResolver,
} from '@exprtlabs/golem/emitter';

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

function literal(value: string | number | boolean): ModelConversionDescriptor {
  return { kind: 'literal', value };
}

function compileConversion(
  expression: string,
  bindings: Readonly<Record<string, unknown>>,
): CompiledConversion {
  const source = [
    'export function run(value: unknown): unknown {',
    `  return (${expression});`,
    '}',
  ].join('\n');
  const output = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
  }).code;
  const moduleRecord: { readonly exports: Record<string, unknown> } = { exports: {} };
  const names = Object.keys(bindings);
  const values = names.map((name) => bindings[name]);
  const factory = new Function(
    'exports',
    'module',
    ...names,
    `${output}\nreturn module.exports.run;`,
  ) as (...arguments_: unknown[]) => unknown;
  const run = factory(moduleRecord.exports, moduleRecord, ...values);
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

  public toJSON(): { readonly name: string } {
    return { name: this.name };
  }
}

const fromChild: FromJsonModelResolver = {
  className: 'ChildModel',
  decode: (value) => `decodeGeneratedModel(ChildModel, ${value})`,
  fromInit: (value) => `ChildModel.fromInit(${value})`,
};

const toChild: ToJsonModelResolver = {
  className: 'ChildModel',
  encode: (value) => `encodeGeneratedModel(${value})`,
};

let decodeCalls = 0;
let encodeCalls = 0;

function decodeToken(value: unknown): number {
  decodeCalls += 1;
  const text = String(value);
  if (!text.startsWith('token:')) throw new TypeError('Invalid token.');
  return Number(text.slice('token:'.length));
}

function encodeToken(value: unknown): string {
  encodeCalls += 1;
  return `token:${String(value)}`;
}

const serde: SerdeResolver = {
  deserialize: (_id, value) => `decodeToken(${value})`,
  serialize: (_id, value) => `encodeToken(${value})`,
};

const bindings: Readonly<Record<string, unknown>> = {
  convertModelField,
  convertModelItems,
  convertModelTupleItems,
  ChildModel,
  decodeGeneratedModel: (_constructor: unknown, value: unknown) =>
    value instanceof ChildModel ? value : ChildModel.fromJSON(value),
  encodeGeneratedModel: (value: unknown) =>
    value instanceof ChildModel ? value.toJSON() : value,
  decodeToken,
  encodeToken,
  deserializeDate,
  serializeDate,
  withDiscriminatorValue,
};

function resetCounters(): void {
  ChildModel.fromJsonCalls = 0;
  ChildModel.fromInitCalls = 0;
  decodeCalls = 0;
  encodeCalls = 0;
}

test('intersection conversion merges object fields and runs overlapping conversions once', () => {
  resetCounters();
  const date = { kind: 'date' } as const;
  const child = { kind: 'generated-model', id: 'child' } as const;
  const token = {
    kind: 'number',
    serde: { id: 'token', wire: { kind: 'string' } },
  } as const;
  const descriptor: ModelConversionDescriptor = {
    kind: 'intersection',
    variants: [
      objectDescriptor({ when: date, child, token }),
      objectDescriptor({ when: date, token, label: { kind: 'string' } }),
    ],
  };

  const fromJSON = compileConversion(
    emitModelFromJSON(descriptor, 'value', () => fromChild, serde),
    bindings,
  );
  const toJSON = compileConversion(
    emitModelToJSON(descriptor, 'value', () => toChild, serde),
    bindings,
  );

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

  const encoded = toJSON({
    when: decoded.when,
    child: decoded.child,
    token: decoded.token,
    label: decoded.label,
  }) as Record<string, unknown>;
  assert.deepEqual(encoded, {
    when: '2025-01-02T03:04:05.000Z',
    child: { name: 'nested' },
    token: 'token:7',
    label: 'intersection',
  });
  assert.equal(encodeCalls, 1, 'an overlapping serde field is encoded once');
});

test('intersection and nullable fromInit preserve domain Date values while constructing nested models', () => {
  resetCounters();
  const domainDate = new Date('2025-02-03T04:05:06.000Z');
  const descriptor: ModelConversionDescriptor = {
    kind: 'intersection',
    variants: [
      objectDescriptor({ when: { kind: 'date' }, child: { kind: 'generated-model', id: 'child' } }),
      objectDescriptor({ when: { kind: 'date' }, token: { kind: 'number', serde: { id: 'token', wire: { kind: 'string' } } } }),
    ],
  };
  const fromInit = compileConversion(
    emitModelFromInit(descriptor, 'value', () => fromChild),
    bindings,
  );
  const nullableDate = compileConversion(
    emitModelFromInit({ kind: 'union', variants: [{ kind: 'date' }, { kind: 'null' }] }, 'value', () => fromChild),
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
        when: { kind: 'date' },
        token: { kind: 'number', serde: { id: 'token', wire: { kind: 'string' } } },
      }),
      objectDescriptor({
        kind: literal('child'),
        when: { kind: 'date' },
        child: { kind: 'generated-model', id: 'child' },
      }),
    ],
  };
  const fromJSON = compileConversion(
    emitModelFromJSON(descriptor, 'value', () => fromChild, serde),
    bindings,
  );
  const toJSON = compileConversion(
    emitModelToJSON(descriptor, 'value', () => toChild, serde),
    bindings,
  );

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

  assert.deepEqual(toJSON(tokenBranch), {
    kind: 'token',
    when: '2025-03-04T05:06:07.000Z',
    token: 'token:11',
  });
  assert.deepEqual(toJSON(childBranch), {
    kind: 'child',
    when: '2025-03-04T05:06:07.000Z',
    child: { name: 'branch' },
  });
  assert.equal(encodeCalls, 1, 'only the selected token branch is encoded');
});

test('ambiguous union conversions fail generation instead of probing codecs', () => {
  const token: ModelConversionDescriptor = { kind: 'number', serde: { id: 'token', wire: { kind: 'string' } } };
  const cases: readonly { name: string; descriptor: ModelConversionDescriptor; message: RegExp }[] = [
    {
      name: 'object variants with the same discriminator',
      descriptor: {
        kind: 'union',
        variants: [
          objectDescriptor({ when: { kind: 'date' } }),
          objectDescriptor({ when: { kind: 'date' } }),
        ],
      },
      message: /unique|required literal discriminator|ambiguous/i,
    },
    {
      name: 'date or date array',
      descriptor: {
        kind: 'union',
        variants: [
          { kind: 'date' },
          { kind: 'array', item: { kind: 'date' } },
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
  ];
  for (const { name, descriptor, message } of cases) {
    assert.throws(() => emitModelFromJSON(descriptor, 'value', () => fromChild, serde), message, name);
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
  assert.equal(emitModelFromJSON(status, 'value', () => fromChild), 'value', 'identity unions emit no Array.isArray map');
  assert.equal(emitModelToJSON(status, 'value', () => toChild), 'value');
  assert.doesNotMatch(emitModelFromJSON(status, 'value', () => fromChild), /Array\.isArray/);
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
  const source = emitModelFromJSON(descriptor, 'value', () => fromChild, serde);
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
