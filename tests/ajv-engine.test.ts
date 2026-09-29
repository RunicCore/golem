import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenApiAjvEngine } from '@exprtlabs/codegen/ajv';

test('the OpenAPI Ajv engine enforces $dynamicRef/$dynamicAnchor recursion, unevaluatedProperties, and allErrors', async () => {
  const engine = createOpenApiAjvEngine();
  const treeId = 'https://schemas.example.test/tree';
  const strictTreeId = 'https://schemas.example.test/strict-tree';
  engine.addSchema({
    $id: treeId,
    $dynamicAnchor: 'node',
    type: 'object',
    properties: {
      data: true,
      children: {
        type: 'array',
        items: { $dynamicRef: '#node' },
      },
    },
  }, treeId);
  engine.addSchema({
    $id: strictTreeId,
    $dynamicAnchor: 'node',
    $ref: treeId,
    unevaluatedProperties: false,
  }, strictTreeId);
  const validateStrictTree = engine.getSchema(strictTreeId);
  assert.ok(validateStrictTree);
  assert.equal(await validateStrictTree({
    data: 'root',
    children: [{ data: 'child' }],
  }), true);
  assert.equal(await validateStrictTree({
    data: 'root',
    children: [{ data: 'child', misspelled: true }],
  }), false);

  const closedExtensionId = 'urn:runic:test:closed-extension';
  engine.addSchema({
    $id: closedExtensionId,
    type: 'object',
    allOf: [{
      properties: {
        street: { type: 'string' },
        city: { type: 'string' },
      },
      required: ['street', 'city'],
    }],
    properties: {
      kind: { enum: ['home', 'business'] },
    },
    required: ['kind'],
    unevaluatedProperties: false,
  }, closedExtensionId);
  const validateClosedExtension = engine.getSchema(closedExtensionId);
  assert.ok(validateClosedExtension);
  assert.equal(await validateClosedExtension({
    street: 'Main',
    city: 'Hanoi',
    kind: 'business',
  }), true);
  assert.equal(await validateClosedExtension({
    street: 'Main',
    city: 'Hanoi',
    kind: 'business',
    extra: true,
  }), false);

  const id = 'urn:runic:test:schemas';
  engine.addSchema({
    $id: id,
    components: {
      schemas: {
        Money: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'integer', minimum: 1 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
        },
      },
    },
  }, id);
  const validateMoney = engine.getSchema(`${id}#/components/schemas/Money`);
  assert.ok(validateMoney);
  // Rejecting an invalid amount/currency pair is native Ajv minimum/pattern behavior; the
  // configuration this engine adds is allErrors, which collects every failing keyword on
  // that one call instead of stopping at the first.
  await validateMoney({ amount: 0, currency: 'vnd' });
  assert.ok(validateMoney.errors && validateMoney.errors.length >= 2);
});
