import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import YAML from 'yaml';
import { generate } from '#controllers/generator';
import { createControllerFixture, type ControllerFixtureOptions } from '../fixture-templates/controllers/project.js';
import { contentSchema, diagnosticsOf, documentOf, expectSchema, expectValue, operationOf, parameterOf, propertySchema, responseOf, responseSchema, type OpenApiDocument, type OpenApiSchema } from './openapi-document.js';

function fixture(t: TestContext, source: string, options: Pick<ControllerFixtureOptions, 'files'> = {}): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-controller-',
    packageName: 'golem-ts-openapi-controller-fixture',
    sourceFile: 'src/catalog.controller.ts',
    source,
    files: options.files,
  });
}

test('generates a static Nest document with evaluated routes, inheritance, URI versions, and Promise responses', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/generates-a-static-nest-document-with-evaluated-routes-inheritance-uri-version/controller.ts"));
  const result = await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Catalog', version: '1' },
    globalPrefix: 'api',
    uriVersioning: { type: 'URI', prefix: 'v' },
    profile: { validation: false },
  });
  const document = documentOf(result);
  assert.equal(document.openapi, '3.2.0');
  const list = operationOf(document, '/api/cats/catalog/list', 'get');
  assert.equal(list.summary, 'List cats');
  operationOf(document, '/api/cats/{id}', 'get');
  assert.equal(parameterOf(document, '/api/cats/{id}', 'get').style, 'simple');
  assert.equal(responseSchema(document, '/api/cats/{id}', 'get', '200').type, 'object');
  assert.equal(operationOf(document, '/api/cats/{id}', 'get').responses['201'], undefined);
  const versionOne = operationOf(document, '/api/v1/cats', 'post');
  assert.ok(operationOf(document, '/api/v2/cats', 'post'));
  assert.ok(responseOf(document, '/api/v1/cats', 'post', '201'));
  assert.equal(versionOne.responses['200'], undefined);
  assert.ok(responseOf(document, '/api/v1/cats', 'post', '400'));
  assert.match(expectValue(versionOne.operationId, 'version 1 operation ID'), /version_1$/);
});

test('emits a whole query object as OpenAPI 3.2 querystring content', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/emits-a-whole-query-object-as-openapi-3-2-querystring-content/controller.ts"));
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Search', version: '1' },
    profile: { validation: false },
  }));
  const parameter = parameterOf(document, '/search', 'get');
  assert.equal(parameter.in, 'querystring');
  assert.equal(parameter.name, 'query');
  const querySchema = contentSchema(parameter, 'application/x-www-form-urlencoded', 'querystring parameter');
  assert.equal(querySchema.type, 'object');
  assert.equal(propertySchema(querySchema, 'page').type, 'number');
});

test('emits flattened primitive query parameters with OpenAPI form style and supports 3.1.2', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/emits-flattened-primitive-query-parameters-with-openapi-form-style-and-support/controller.ts"));
  const result = await generate({
    root,
    output: path.join(root, 'openapi.yaml'),
    openapiVersion: '3.1.2',
    info: { title: 'Search', version: '1' },
    profile: { validation: false },
  });
  const artifact = result.artifacts[0];
  assert.ok(artifact);
  const document = YAML.parse(artifact.content) as OpenApiDocument;
  const picks = {
    openapi: document.openapi,
    parameters: [0, 1].map(index => {
      const { name, style, explode } = parameterOf(document, '/search', 'get', index);
      return { name, style, explode };
    }),
  };
  assert.deepEqual(picks, {
    openapi: '3.1.2',
    parameters: [
      { name: 'page', style: 'form', explode: true },
      { name: 'term', style: 'form', explode: true },
    ],
  });
});

test('preserves Swagger status, media, and parameter metadata', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/preserves-swagger-status-media-and-parameter-metadata/controller.ts"));
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Results', version: '1' },
    profile: { validation: false },
  }));
  const term = parameterOf(document, '/results', 'get');
  assert.equal(term.required, false);
  assert.equal(term.description, 'Search term');
  assert.equal(expectSchema(expectValue(term.schema, 'term schema'), 'term schema').default, 'all');
  assert.equal(expectValue(responseOf(document, '/results', 'get', '206').description, 'partial response description'), 'Partial result');
  assert.equal(responseSchema(document, '/results', 'get', '206').type, 'object');
  const post = operationOf(document, '/results', 'post');
  const requestBody = expectValue(post.requestBody, 'results request body');
  contentSchema(requestBody, 'application/json', 'results request body');
  assert.equal(responseSchema(document, '/results', 'post', '202').type, 'object');
  assert.equal(responseSchema(document, '/results', 'post', '202', 'application/problem+json').type, 'object');
});

test('rejects conflicting static routes with a structured diagnostic', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/rejects-conflicting-static-routes-with-a-structured-diagnostic/controller.ts"));
  await assert.rejects(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Conflicts', version: '1' },
      profile: { validation: false },
    }),
    (error: unknown) => {
      return diagnosticsOf(error).some(item => item.code === 'NEST1306');
    },
  );
});

test('applies actual Swagger DTO property metadata without consulting class-validator', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/applies-actual-swagger-dto-property-metadata-without-consulting-class-validato/controller.ts"));
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Addresses', version: '1' },
    profile: { validation: false },
  }));
  const schema = responseSchema(document, '/addresses', 'get', '200');
  assert.equal(propertySchema(schema, 'city').description, 'Postal city');
  assert.equal(propertySchema(schema, 'city').type, 'string');
  assert.equal(propertySchema(schema, 'country').example, 'FR');
  assert.equal(schema.properties?.internalToken, undefined);
  assert.deepEqual(schema.required, ['city']);
});

test('resolves imported and re-exported DTO constructors in ApiProperty type metadata', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/resolves-imported-and-re-exported-dto-constructors-in-apiproperty-type-metadat/controller.ts"), {
    files: {
      'src/address.dto.ts': readFixture('controllers/controller/resolves-imported-and-re-exported-dto-constructors-in-apiproperty-type-metadat/address.dto.ts'),
      'src/address.index.ts': readFixture('controllers/controller/resolves-imported-and-re-exported-dto-constructors-in-apiproperty-type-metadat/address.index.ts'),
    },
  });
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Imported DTO', version: '1' },
    profile: { validation: false },
  }));
  const schema = responseSchema(document, '/imported-dto', 'get', '200');
  const address = propertySchema(schema, 'address');
  assert.equal(address.description, 'Customer address');
  assert.equal(address.type, 'object');
  assert.equal(propertySchema(address, 'city').type, 'string');
});

test('does not treat a project-local String function as a Swagger primitive constructor', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/does-not-treat-a-project-local-string-function-as-a-swagger-primitive-construc/controller.ts"));
  await assert.rejects(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Local constructor', version: '1' },
      profile: { validation: false },
    }),
    (error: unknown) => String(error).includes('NEST1503'),
  );
});

test('rejects a Swagger schema that conflicts with an authoritative IModel wire contract', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/rejects-a-swagger-schema-that-conflicts-with-an-authoritative-imodel-wire-cont/controller.ts"));
  await assert.rejects(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Payments', version: '1' },
      profile: { validation: false },
    }),
    (error: unknown) => diagnosticsOf(error).some(item => item.code === 'NEST1503'
      // The message names the keyword path, both values, and how to change the contract.
      && /properties\.id\.type/.test(String(item.message))
      && /"number"/.test(String(item.message))
      && /"string"/.test(String(item.message))
      && /return type/.test(String(item.message))),
  );
});

test('rejects stream responses without explicit Swagger content', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/rejects-stream-responses-without-explicit-swagger-content/controller.ts"));
  await assert.rejects(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Files', version: '1' },
      profile: { validation: false },
    }),
    (error: unknown) => String(error).includes('NEST1310'),
  );
});

test('recognizes Nest decorators through local reexports of public package exports', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/recognizes-nest-decorators-through-local-reexports-of-public-package-exports/controller.ts"), {
    files: {
      'src/http.ts': readFixture('controllers/controller/recognizes-nest-decorators-through-local-reexports-of-public-package-exports/http.ts'),
    },
  });
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Reexported', version: '1' },
    profile: { validation: false },
  }));
  assert.ok(operationOf(document, '/reexported', 'get'));
});

test('resolves HttpStatus enum members and preserves Nest URI version concatenation', async (t: TestContext) => {
  // protects: T-362 HttpStatus members give the Nest response codes, and a URI version prefixes only the versioned routes
  const root = fixture(t, readFixture("controllers/controller/resolves-httpstatus-enum-members-and-preserves-nest-uri-version-concatenation/controller.ts"));
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    uriVersioning: { type: 'URI', prefix: 'v' },
    info: { title: 'Status', version: '1' },
    profile: { validation: false },
  }));
  assert.deepEqual(document.paths, {
    '/v1/status/get': { get: { operationId: 'StatusController_get', responses: { '200': { description: '' } } } },
    '/v1/status/post': { post: { operationId: 'StatusController_post', responses: { '201': { description: '' } } } },
    '/v1/status/put': { put: { operationId: 'StatusController_put', responses: { '200': { description: '' } } } },
    '/v1/status/patch': { patch: { operationId: 'StatusController_patch', responses: { '200': { description: '' } } } },
    '/v1/status/delete': { delete: { operationId: 'StatusController_remove', responses: { '200': { description: '' } } } },
    '/v1/status/options': { options: { operationId: 'StatusController_options', responses: { '200': { description: '' } } } },
    '/v1/status/head': { head: { operationId: 'StatusController_head', responses: { '200': { description: '' } } } },
    '/status/neutral': { get: { operationId: 'StatusController_neutral', responses: { '200': { description: '' } } } },
    '/status/empty': { get: { operationId: 'StatusController_empty', responses: { '204': { description: '' } } } },
  });
});

test('a route helper result over 1 MiB stops with RUNT2106 until maxResultBytes is raised', async (t: TestContext) => {
  // protects: T-376 the route result limit is an option; the default stays 1 MiB
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
function bigPath() { return '${'a'.repeat(1024 * 1024)}'; }
@Controller(bigPath()) export class BigController { @Get() get(): void {} }`);
  const context = { root, output: path.join(root, 'openapi.json'), info: { title: 'Big', version: '1' }, profile: { validation: false } };
  await assert.rejects(generate(context), (error: unknown) => diagnosticsOf(error).some(item => item.code === 'RUNT2106'));
  assert.equal(Object.keys(documentOf(await generate({ ...context, maxResultBytes: 2 * 1024 * 1024 })).paths).length, 1);
});

test('rejects @HostParam routes', async (t: TestContext) => {
  const source = `import { Controller, Get, HostParam } from '@nestjs/common';
@Controller('host') export class HostController { @Get() get(@HostParam('tenant') tenant: string): void {} }`;
  const root = fixture(t, source);
  await assert.rejects(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Unsupported', version: '1' },
      profile: { validation: false },
    }),
    (error: unknown) => diagnosticsOf(error).some(item => item.code === 'NEST1101'),
  );
});

test('keeps Nest runtime status authoritative over a contradicting Swagger success response', async (t: TestContext) => {
  const cases = [
    { title: 'Status conflict', fixtureDirectory: 'rejects-a-swagger-success-status-that-contradicts-nest-post-runtime-status' },
    { title: 'No content conflict', fixtureDirectory: 'keeps-nest-runtime-status-authoritative-over-apinocontentresponse' },
  ];
  for (const { title, fixtureDirectory } of cases) {
    const root = fixture(t, readFixture(`controllers/controller/${fixtureDirectory}/controller.ts`));
    await assert.rejects(
      generate({
        root,
        output: path.join(root, 'openapi.json'),
        info: { title, version: '1' },
        profile: { validation: false },
      }),
      (error: unknown) => String(error).includes('NEST1311'),
    );
  }
});

test('accepts constant Nest and Swagger response statuses', async (t: TestContext) => {
  const constantRoot = fixture(t, `import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
const STATUS = 204;
const ERROR_STATUS = '4XX';
@Controller('constant-status') export class ConstantStatusController { @Get() @HttpCode(STATUS) @ApiResponse({ status: ERROR_STATUS, description: 'client error' }) get(): void {} }`);
  const constantDocument = documentOf(await generate({
    root: constantRoot,
    output: path.join(constantRoot, 'openapi.json'),
    info: { title: 'Constant response status', version: '1' },
    profile: { validation: false },
  }));
  assert.deepEqual(Object.keys(constantDocument.paths['/constant-status']?.get?.responses ?? {}).sort(), ['204', '4XX']);
});

test('allows manually managed responses with explicit Swagger response metadata', async (t: TestContext) => {
  const acceptedRoot = fixture(t, readFixture("controllers/controller/allows-manually-managed-responses-only-with-explicit-swagger-response-metadata/controller.ts"));
  const document = documentOf(await generate({
    root: acceptedRoot,
    output: path.join(acceptedRoot, 'openapi.json'),
    info: { title: 'Manual response', version: '1' },
    profile: { validation: false },
  }));
  assert.deepEqual(expectValue(responseOf(document, '/manual-response', 'get', '200').content, 'manual response content'), {
    'application/json': { schema: { type: 'string' } },
  });
});

test('rejects unresolved local component references in raw Swagger response metadata', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/controller/rejects-unresolved-local-component-references-in-raw-swagger-response-metadata/controller.ts"));
  await assert.rejects(
    generate({
      root,
      output: path.join(root, 'openapi.json'),
      info: { title: 'Unresolved reference', version: '1' },
      profile: { validation: false },
    }),
    (error: unknown) => String(error).includes('NEST1505'),
  );
});

test('configured suffixes select the controller sources and name their operations as before', async (t: TestContext) => {
  const controller = (name: string, route: string): string => `import { Controller, Get } from '@nestjs/common';

@Controller('${route}')
export class ${name} {
  @Get()
  list(): void {}
}
`;
  const root = createControllerFixture(t, {
    prefix: 'golem-ts-openapi-suffixes-',
    sourceFile: 'src/cats.api.ts',
    source: controller('CatsController', 'cats'),
    files: { 'src/dogs.controller.ts': controller('DogsController', 'dogs') },
  });
  // A variable keeps the test free of the context type, which names the suffixes only once they exist.
  const context = { root, output: path.join(root, 'openapi.json'), suffixes: ['.api.ts'], info: { title: 'Pets', version: '1' }, profile: { validation: false } };
  const document = documentOf(await generate(context));
  assert.equal(operationOf(document, '/cats', 'get').operationId, 'CatsController_list');
  assert.equal(document.paths['/dogs'], undefined, 'a file without a configured suffix is not a controller source');
});

test('documents a controller with @ApiExcludeController(false) and skips one with @ApiExcludeController()', async (t: TestContext) => {
  // protects: T-172 Swagger skips a controller only when ApiExcludeController is true
  const source = `import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

@ApiExcludeController(false)
@Controller('shown')
export class ShownController {
  @Get()
  list(): void {}
}

@ApiExcludeController()
@Controller('hidden')
export class HiddenController {
  @Get()
  list(): void {}
}
`;
  const root = createControllerFixture(t, { prefix: 'golem-ts-openapi-exclude-controller-', source });
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Exclude controller', version: '1' },
    profile: { validation: false },
  }));
  assert.deepEqual(Object.keys(document.paths), ['/shown']);
});

test('writes a recursive alias of a response as one component that refers to itself', async (t: TestContext) => {
  // protects: T-221 a recursive type alias becomes one self-referencing OpenAPI component, not an inlined or rejected schema
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

@Controller('json')
export class JsonController {
  @Get('value')
  value(): JsonValue {
    return { a: [1] };
  }

  @Get('wrapped')
  wrapped(): { data: JsonValue } {
    return { data: null };
  }
}
`);
  const document = documentOf(await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Json', version: '1' },
    profile: { validation: false },
  }));
  const components = (document as unknown as { readonly components: { readonly schemas: Readonly<Record<string, OpenApiSchema>> } }).components.schemas;
  const names = Object.keys(components).filter((name) => name.startsWith('JsonValue'));
  assert.equal(names.length, 1, 'one component for the alias');
  const reference = { $ref: `#/components/schemas/${names[0]}` };
  const branches = expectValue(expectValue(components[names[0]], 'the JsonValue component').anyOf, 'JsonValue anyOf') as readonly OpenApiSchema[];
  assert.deepEqual(expectValue(branches.find((branch) => branch.type === 'array'), 'the array branch').items, reference);
  assert.deepEqual(expectValue(branches.find((branch) => branch.type === 'object'), 'the record branch').additionalProperties, reference);
  assert.deepEqual(responseSchema(document, '/json/value', 'get', '200'), components[names[0]], 'the response holds the alias body, which refers to the component');
  assert.deepEqual(propertySchema(responseSchema(document, '/json/wrapped', 'get', '200'), 'data'), reference);
});
