import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkOpenApiStructure,
  checkSchemaObjects,
  formatOpenApiProblems,
  mostSpecificProblems,
  validateOpenApiDocument,
  type OpenApiProblem,
} from '#openapi/openapi-validator';

function documentBase(openapi: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { openapi, info: { title: 'Fixture', version: '1' }, paths: {}, ...extra };
}

function pointers(problems: readonly OpenApiProblem[]): string[][] {
  return problems.map((problem) => [problem.ruleId, problem.pointer]);
}

function operationWith(extra: Record<string, unknown>): Record<string, unknown> {
  return { '/a': { get: { responses: { 200: { description: 'ok' } }, ...extra } } };
}

test('official 3.1 and 3.2 schemas accept minimal documents', () => {
  assert.deepEqual(checkOpenApiStructure(documentBase('3.1.0')), []);
  assert.deepEqual(checkOpenApiStructure(documentBase('3.2.0')), []);
});

test('structure errors carry the instance pointer', () => {
  const problems = checkOpenApiStructure({ openapi: '3.1.0', info: { title: 'x' }, paths: {} });
  assert.deepEqual(pointers(problems), [['struct', '/info']]);
  assert.match(problems[0]?.message ?? '', /version/);
});

test('boolean schemas are valid in 3.1 and 3.2', () => {
  for (const openapi of ['3.1.0', '3.2.0']) {
    const document = documentBase(openapi, {
      components: { schemas: { Any: true, Closed: { type: 'object', properties: { x: false } } } },
    });
    assert.deepEqual(validateOpenApiDocument(document), [], openapi);
  }
});

test('cookie style is valid only in 3.2', () => {
  const parameters = [{ name: 's', in: 'cookie', style: 'cookie', schema: { type: 'string' } }];
  assert.deepEqual(
    pointers(checkOpenApiStructure(documentBase('3.1.0', { paths: operationWith({ parameters }) }))),
    [['struct', '/paths/~1a/get/parameters/0/style']],
  );
  assert.deepEqual(checkOpenApiStructure(documentBase('3.2.0', { paths: operationWith({ parameters }) })), []);
});

test('misplaced $ref is a struct error (spec-strict-refs)', () => {
  const problems = checkOpenApiStructure(documentBase('3.1.0', {
    info: { title: 'x', version: '1', $ref: '#/components/schemas/A' },
  }));
  assert.deepEqual(pointers(problems), [['struct', '/info']]);
  assert.match(problems[0]?.message ?? '', /property "\$ref" is not allowed/);
});

test('example value exclusivity is a struct error (spec-example-values)', () => {
  const external = documentBase('3.1.0', {
    components: { examples: { E: { value: 1, externalValue: 'https://x.example/e.json' } } },
  });
  assert.deepEqual(pointers(checkOpenApiStructure(external)), [['struct', '/components/examples/E']]);
  const dataValue = documentBase('3.2.0', { components: { examples: { E: { value: 1, dataValue: 1 } } } });
  assert.deepEqual(pointers(checkOpenApiStructure(dataValue)), [['struct', '/components/examples/E']]);
});

test('3.2 encoding combinations and querystring limits are struct errors', () => {
  const encoding = documentBase('3.2.0', {
    paths: {
      '/a': {
        get: {
          responses: {
            200: {
              description: 'ok',
              content: { 'multipart/mixed': { encoding: { a: {} }, prefixEncoding: [{}] } },
            },
          },
        },
      },
    },
  });
  assert.ok(checkOpenApiStructure(encoding).some((problem) => problem.pointer.endsWith('/prefixEncoding')));
  const form = { 'application/x-www-form-urlencoded': {} };
  const querystring = documentBase('3.2.0', {
    paths: operationWith({
      parameters: [
        { name: 'a', in: 'querystring', content: form },
        { name: 'b', in: 'querystring', content: form },
      ],
    }),
  });
  assert.ok(checkOpenApiStructure(querystring).some((problem) => problem.pointer === '/paths/~1a/get/parameters'));
});

test('Schema Objects are checked against the JSON Schema 2020-12 meta-schema', () => {
  const document = documentBase('3.1.0', {
    components: {
      schemas: {
        X: { type: 'strng' },
        Y: { type: 'object', properties: { a: { minLength: -1 } } },
        Z: { type: ['string', 'null'], discriminator: { propertyName: 'k' } },
      },
    },
  });
  assert.deepEqual(pointers(checkSchemaObjects(document)), [
    ['schema', '/components/schemas/X/type'],
    ['schema', '/components/schemas/Y/properties/a/minLength'],
  ]);
});

test('Schema Object checks are skipped when the structure is invalid', () => {
  const problems = validateOpenApiDocument({
    openapi: '3.1.0',
    info: { title: 'x' },
    paths: {},
    components: { schemas: { X: { type: 'strng' } } },
  });
  assert.deepEqual(pointers(problems), [['struct', '/info']]);
});

test('formatOpenApiProblems reports the total and at most 20 lines', () => {
  const problems = Array.from({ length: 25 }, (_, index) => ({
    ruleId: 'struct',
    message: `problem ${index}`,
    pointer: `/p${index}`,
  }));
  const text = formatOpenApiProblems(problems, (pointer) => `api.json#${pointer}`);
  const lines = text.split('\n');
  assert.equal(lines[0], 'OpenAPI validation failed with 25 error(s):');
  assert.equal(lines.length, 21);
  assert.equal(lines[1], 'struct: problem 0 (api.json#/p0)');
});

test('formatOpenApiProblems maps a related pointer through the same locate function', () => {
  const text = formatOpenApiProblems(
    [{ ruleId: 'operation-operationId-unique', message: 'operationId "x" is used more than once', pointer: '/b', relatedPointer: '/a' }],
    (pointer) => `api.json#${pointer}`,
  );
  assert.equal(
    text,
    'OpenAPI validation failed with 1 error(s):\noperation-operationId-unique: operationId "x" is used more than once (also at api.json#/a) (api.json#/b)',
  );
});

test('wrapper and parent errors collapse to the most specific error', () => {
  assert.deepEqual(mostSpecificProblems([
    { ruleId: 'struct', message: 'must be equal to constant', pointer: '/p/0/style' },
    { ruleId: 'struct', message: 'must NOT have unevaluated properties', pointer: '/p/0' },
    { ruleId: 'schema', message: 'first', pointer: '/s/type' },
    { ruleId: 'schema', message: 'second', pointer: '/s/type' },
    { ruleId: 'struct', message: 'root', pointer: '' },
  ]), [
    { ruleId: 'struct', message: 'must be equal to constant', pointer: '/p/0/style' },
    { ruleId: 'schema', message: 'first', pointer: '/s/type' },
  ]);
});
