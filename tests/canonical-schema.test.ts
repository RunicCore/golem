import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import {
  assembleConstraintSchema,
  schemaForDescriptor,
  type JsonSchema,
  type ModelConstraint,
} from '@exprtlabs/golem/schema';

function validator(schema: JsonSchema): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: false });
  return ajv.compile(schema as AnySchema);
}

function assertAccepts(validate: ValidateFunction, value: unknown): void {
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

function assertRejects(validate: ValidateFunction, value: unknown): void {
  assert.equal(validate(value), false, `expected rejection for ${JSON.stringify(value)}`);
}

function objectDescriptor(
  properties: Record<string, unknown>,
  constraints: readonly ModelConstraint[] = [],
  additionalProperties: boolean | unknown = false,
): Record<string, unknown> {
  return {
    kind: 'object',
    properties,
    required: [],
    additionalProperties,
    ...(constraints.length ? { constraints } : {}),
  };
}

test('recursive references compile through local $defs and OpenAPI component prefixes', () => {
  const node = objectDescriptor({
    value: { kind: 'number', constraints: [{ kind: 'integer' }] },
    next: {
      kind: 'union',
      variants: [
        { kind: 'reference', name: 'Node' },
        { kind: 'null' },
      ],
    },
  });

  const local = schemaForDescriptor(
    { kind: 'reference', name: 'Node' },
    { definitions: { Node: node } },
  );
  assert.equal(typeof local, 'object');
  assert.ok(typeof local === 'object' && local !== null);
  const localDefinitions = (local as Record<string, unknown>).$defs;
  assert.ok(typeof localDefinitions === 'object' && localDefinitions !== null && 'Node' in localDefinitions);
  const localValidate = validator(local);
  assertAccepts(localValidate, { value: 1, next: { value: 2, next: null } });
  assertRejects(localValidate, { value: 1, next: { value: 'bad' } });

  const componentNode = schemaForDescriptor(node, {
    definitions: { Node: node },
    referencePrefix: '#/components/schemas/',
  });
  assert.ok(typeof componentNode === 'object' && componentNode !== null);
  assert.equal('$defs' in componentNode, false);
  const openApiRoot = {
    $id: 'https://example.test/canonical-schema-openapi-root',
    $ref: '#/components/schemas/Node',
    components: { schemas: { Node: componentNode } },
  };
  const componentValidate = validator(openApiRoot);
  assertAccepts(componentValidate, { value: 1, next: { value: 2, next: null } });
  assertRejects(componentValidate, { value: 1, next: { value: 'bad' } });
});

test('false and never descriptors stay impossible when constraints are attached', () => {
  const never = schemaForDescriptor({
    kind: 'never',
    constraints: [{ kind: 'minProperties', value: 1 }],
  });
  assert.equal(never, false);
  const neverValidate = validator(never);
  assertRejects(neverValidate, {});
  assertRejects(neverValidate, { value: true });

  const undefinedValue = schemaForDescriptor({
    kind: 'undefined',
    constraints: [{ kind: 'pattern', value: '^present$' }],
  });
  assert.equal(undefinedValue, false);
  assertRejects(validator(undefinedValue), 'present');
});

test('contextual additional and unevaluated property constraints keep declared properties evaluated', () => {
  const additionalFalse = schemaForDescriptor(objectDescriptor(
    { known: { kind: 'string' } },
    [{ kind: 'additionalProperties', schema: false }],
    true,
  ));
  const validateAdditionalFalse = validator(additionalFalse);
  assertAccepts(validateAdditionalFalse, { known: 'ok' });
  assertRejects(validateAdditionalFalse, { known: 'ok', extra: 1 });

  const additionalNumbers = schemaForDescriptor(objectDescriptor(
    { known: { kind: 'string' } },
    [{ kind: 'additionalProperties', schema: { kind: 'number' } }],
    true,
  ));
  const validateAdditionalNumbers = validator(additionalNumbers);
  assertAccepts(validateAdditionalNumbers, { known: 'ok', extra: 1 });
  assertRejects(validateAdditionalNumbers, { known: 'ok', extra: 'bad' });

  const unevaluated = {
    type: 'object',
    properties: { known: { type: 'string' } },
    ...assembleConstraintSchema([{ kind: 'unevaluatedProperties', schema: false }]),
  } as JsonSchema;
  const validateUnevaluated = validator(unevaluated);
  assertAccepts(validateUnevaluated, { known: 'ok' });
  assertRejects(validateUnevaluated, { known: 'ok', extra: 1 });
});

test('unevaluated items remain contextual across prefix item schemas', () => {
  const schema = {
    type: 'array',
    prefixItems: [{ type: 'string' }],
    ...assembleConstraintSchema([{ kind: 'unevaluatedItems', schema: false }]),
  } as JsonSchema;
  const validate = validator(schema);
  assertAccepts(validate, ['first']);
  assertRejects(validate, ['first', 2]);
  assertRejects(validate, [1]);
});

test('fixed tuples reject items beyond prefixItems', () => {
  const schema = schemaForDescriptor({
    kind: 'object',
    properties: {
      tuple: { kind: 'tuple', items: [{ kind: 'string' }, { kind: 'number' }] },
    },
    required: ['tuple'],
    additionalProperties: false,
  });
  const validate = validator(schema);
  assertAccepts(validate, { tuple: ['name', 2] });
  assertRejects(validate, { tuple: ['name', 2, true] });
});

test('contains, minContains, and maxContains share one validation context', () => {
  const schema = schemaForDescriptor({
    kind: 'array',
    item: { kind: 'string' },
    constraints: [
      { kind: 'contains', schema: { kind: 'literal', value: 'x' } },
      { kind: 'minContains', value: 1 },
      { kind: 'maxContains', value: 2 },
    ],
  });
  const validate = validator(schema);
  assertRejects(validate, ['a', 'b']);
  assertAccepts(validate, ['x', 'a']);
  assertAccepts(validate, ['x', 'x']);
  assertRejects(validate, ['x', 'x', 'x']);
});

test('patternProperties and dependentSchemas compose with additional and unevaluated properties', () => {
  const schema = schemaForDescriptor(objectDescriptor(
    {
      flag: { kind: 'boolean' },
      requiredWhenFlag: { kind: 'string' },
    },
    [
      {
        kind: 'patternProperties',
        pattern: '^x_',
        schema: { kind: 'number' },
      },
      {
        kind: 'dependentSchemas',
        value: {
          flag: {
            kind: 'object',
            properties: { requiredWhenFlag: { kind: 'string' } },
            required: ['requiredWhenFlag'],
            additionalProperties: true,
          },
        },
      },
      { kind: 'unevaluatedProperties', schema: false },
    ],
    false,
  ));
  const validate = validator(schema);
  assertAccepts(validate, { flag: true, requiredWhenFlag: 'yes', x_count: 2 });
  assertAccepts(validate, { x_count: 2 });
  assertRejects(validate, { flag: true, x_count: 2 });
  assertRejects(validate, { x_count: 'two' });
  assertRejects(validate, { other: 2 });
});

test('conflicting duplicate constraints become intersecting branches with effective bounds', () => {
  const constraints: readonly ModelConstraint[] = [
    { kind: 'minLength', value: 2 },
    { kind: 'minLength', value: 4 },
    { kind: 'maxLength', value: 6 },
    { kind: 'maxLength', value: 5 },
  ];
  const assembled = assembleConstraintSchema(constraints);
  assert.ok('allOf' in assembled);
  const validate = validator(schemaForDescriptor({ kind: 'string', constraints }));
  assertRejects(validate, 'abc');
  assertAccepts(validate, 'abcd');
  assertAccepts(validate, 'abcde');
  assertRejects(validate, 'abcdef');

  const duplicate = assembleConstraintSchema([
    { kind: 'minLength', value: 4 },
    { kind: 'minLength', value: 4 },
  ]);
  assert.deepEqual(duplicate, { minLength: 4 });
});

test('wire schemas erase type-only scalar brands while retaining constraints', () => {
  const schema = schemaForDescriptor({
    kind: 'intersection',
    variants: [
      { kind: 'string' },
      {
        kind: 'object',
        properties: { __wireBrand: { kind: 'undefined' } },
        required: [],
        additionalProperties: false,
      },
    ],
    constraints: [{ kind: 'minLength', value: 2 }],
  }, { representation: 'wire' });
  assert.deepEqual(schema, { allOf: [{ type: 'string' }, { minLength: 2 }] });
  const validate = validator(schema);
  assertAccepts(validate, 'ok');
  assertRejects(validate, 'x');
  assertRejects(validate, { __wireBrand: undefined });
});


test('portable composition follows callback metadata in both serde wire shapes', () => {
  for (const key of ['wire', 'wireDescriptor']) {
    const warnings: string[] = [];
    const projected = schemaForDescriptor({
      kind: 'unknown',
      constraints: [{ kind: 'not', schema: {
        kind: 'unknown',
        serde: { [key]: { kind: 'number', validations: ['positive'] } },
      } }],
    }, { representation: 'wire', portable: true, onNonportable: message => warnings.push(message) });
    assertAccepts(validator(projected), -1);
    assert.ok(warnings.length > 0);
    assert.doesNotMatch(JSON.stringify(projected), /positive|exprtValidation/);
  }
});
