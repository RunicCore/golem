// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { generate } from '#controllers/generator';
import { createControllerFixture, type ControllerFixtureOptions } from '../fixture-templates/controllers/project.js';
import { documentOf, expectValue, operationOf, responseOf, responseSchema } from './openapi-document.js';

function fixture(t: TestContext, source: string, options: Pick<ControllerFixtureOptions, 'files'> = {}): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-endpoint-decorators-',
    packageName: 'golem-ts-openapi-endpoint-decorators-fixture',
    source,
    files: options.files,
  });
}

function generateDocument(root: string, title: string): Promise<Awaited<ReturnType<typeof generate>>> {
  return generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title, version: '1' },
    profile: { validation: false },
  });
}


test('evaluates @Res passthrough true, false, imported constants, and a bare @Res without response metadata', async (t: TestContext) => {
  const acceptedRoot = fixture(t, readFixture('controllers/endpoint-decorators/evaluates-res-passthrough-true-false-and-imported-constants/source.controller.ts'), {
    files: {
      'src/flags.ts': readFixture('controllers/endpoint-decorators/evaluates-res-passthrough-true-false-and-imported-constants/flags.ts'),
    },
  });
  const document = documentOf(await generateDocument(acceptedRoot, 'Passthrough'));
  assert.equal(responseOf(document, '/passthrough/true', 'get', '200').content?.['application/json']?.schema?.type, 'object');
  assert.equal(responseOf(document, '/passthrough/alias', 'get', '200').content?.['application/json']?.schema?.type, 'object');

  const falseRoot = fixture(t, readFixture("controllers/endpoint-decorators/evaluates-res-passthrough-true-false-and-imported-constants/controller-2.ts"));
  await assert.rejects(
    generateDocument(falseRoot, 'Manual false'),
    (error: unknown) => String(error).includes('NEST1101'),
  );

  const falseConstRoot = fixture(t, readFixture("controllers/endpoint-decorators/evaluates-res-passthrough-true-false-and-imported-constants/controller-3.ts"), {
    files: { 'src/flags.ts': readFixture('controllers/endpoint-decorators/evaluates-res-passthrough-true-false-and-imported-constants/manual-flags.ts') },
  });
  await assert.rejects(
    generateDocument(falseConstRoot, 'Manual false constant'),
    (error: unknown) => String(error).includes('NEST1101'),
  );

  const noContractRoot = fixture(t, readFixture("controllers/endpoint-decorators/evaluates-res-passthrough-true-false-and-imported-constants/controller-4.ts"));
  await assert.rejects(
    generateDocument(noContractRoot, 'Manual response without contract'),
    (error: unknown) => String(error).includes('NEST1101'),
  );
});

test('diagnoses unreadable @Res passthrough options', async (t: TestContext) => {
  const cases = [
    `import { Controller, Get, Res } from '@nestjs/common';
let passthrough = true;
@Controller('dynamic-passthrough') export class DynamicPassthroughController {
  @Get() send(@Res({ passthrough }) response: unknown): void {}
}`,
    `import { Controller, Get, Res } from '@nestjs/common';
const options = { passthrough: true };
@Controller('dynamic-options') export class DynamicOptionsController {
  @Get() send(@Res(options) response: unknown): void {}
}`,
  ];
  for (const source of cases) {
    const root = fixture(t, source);
    await assert.rejects(
      generateDocument(root, 'Unreadable passthrough'),
      (error: unknown) => String(error).includes('NEST1101'),
    );
  }
});

test('evaluates @ApiExcludeEndpoint omitted, true, false, and constants', async (t: TestContext) => {
  const root = fixture(t, readFixture('controllers/endpoint-decorators/evaluates-apiexcludeendpoint-omitted-true-false-and-constants/source.controller.ts'), {
    files: { 'src/flags.ts': readFixture('controllers/endpoint-decorators/evaluates-apiexcludeendpoint-omitted-true-false-and-constants/flags.ts') },
  });
  const document = documentOf(await generateDocument(root, 'Visibility'));
  assert.ok(operationOf(document, '/visibility/shown', 'get'));
  assert.equal(document.paths['/visibility/omitted'], undefined);
  assert.equal(document.paths['/visibility/true'], undefined);
  assert.ok(operationOf(document, '/visibility/false', 'get'));
  assert.equal(document.paths['/visibility/const-true'], undefined);
  assert.ok(operationOf(document, '/visibility/const-false', 'get'));
});

test('does not let ApiOperation hidden:false undo an explicit ApiExcludeEndpoint', async (t: TestContext) => {
  const root = fixture(t, readFixture('controllers/endpoint-decorators/does-not-let-apioperation-hidden-false-undo-an-explicit-apiexcludeendpoint/source.controller.ts'));
  const document = documentOf(await generateDocument(root, 'Exclusion'));
  assert.ok(operationOf(document, '/exclusion/kept', 'get'));
  assert.equal(document.paths['/exclusion/still-hidden'], undefined);
  assert.equal(document.paths['/exclusion/operation-hidden'], undefined);
  assert.ok(operationOf(document, '/exclusion/exclude-false', 'get'));
});

test('diagnoses unreadable @ApiExcludeEndpoint values', async (t: TestContext) => {
  const root = fixture(t, readFixture("controllers/endpoint-decorators/diagnoses-unreadable-apiexcludeendpoint-values/controller.ts"));
  await assert.rejects(
    generateDocument(root, 'Unreadable exclude'),
    (error: unknown) => String(error).includes('NEST1201'),
  );
});

test('inherits class Swagger errors into methods and lets a method override the same status', async (t: TestContext) => {
  const root = fixture(t, readFixture('controllers/endpoint-decorators/inherits-class-swagger-errors-into-methods-and-lets-a-method-override-the-same/source.controller.ts'));
  const document = documentOf(await generateDocument(root, 'Class responses'));
  assert.equal(responseOf(document, '/catalog', 'get', '400').description, 'class error');
  assert.equal(responseOf(document, '/catalog', 'get', '200').content?.['application/json']?.schema?.type, 'object');
  assert.equal(responseOf(document, '/catalog/{id}', 'get', '400').description, 'method error');
  assert.equal(responseOf(document, '/catalog/{id}', 'get', '200').content?.['application/json']?.schema?.type, 'object');
});

test('inherits base class Swagger responses into a subclass that declares its own responses', async (t: TestContext) => {
  const root = fixture(t, readFixture('controllers/endpoint-decorators/inherits-base-class-swagger-responses-into-a-subclass-that-declares-its-own-re/source.controller.ts'));
  const document = documentOf(await generateDocument(root, 'Base class responses'));
  assert.equal(responseOf(document, '/derived', 'get', '400').description, 'base 400');
  assert.equal(responseSchema(document, '/derived', 'get', '400').type, 'object');
  assert.equal(responseOf(document, '/derived', 'get', '429').description, 'derived 429');
  assert.equal(responseSchema(document, '/derived', 'get', '200').type, 'object');
  assert.equal(responseOf(document, '/merged-base', 'get', '400').description, 'base 400\n\nderived 400');
  assert.equal(responseSchema(document, '/merged-base', 'get', '400').type, 'object');
  assert.equal(responseOf(document, '/skip-base', 'get', '400').description, 'base 400');
  assert.equal(operationOf(document, '/skip-base', 'get').responses['429'], undefined);
});

test('lets a later scalar Swagger type clear an earlier array response', async (t: TestContext) => {
  const root = fixture(t, readFixture('controllers/endpoint-decorators/lets-a-later-scalar-swagger-type-clear-an-earlier-array-response/source.controller.ts'));
  const document = documentOf(await generateDocument(root, 'Array to scalar'));
  const listSchema = responseSchema(document, '/array-to-scalar/list', 'get', '200');
  assert.equal(listSchema.type, 'array');
  assert.equal(listSchema.items?.type, 'object');
  const tupleSchema = responseSchema(document, '/array-to-scalar/tuple', 'get', '200');
  assert.equal(tupleSchema.type, 'object');
  assert.equal(tupleSchema.items, undefined);
  assert.equal(responseOf(document, '/array-to-scalar/tuple', 'get', '200').description, 'list\n\none');
  const flagSchema = responseSchema(document, '/array-to-scalar/flag', 'get', '200');
  assert.equal(flagSchema.type, 'object');
  assert.equal(flagSchema.items, undefined);
  assert.equal(responseOf(document, '/array-to-scalar/flag', 'get', '200').description, 'list\n\none');
});

test('merges repeated same-status responses in Nest application order and honors overrideExisting false', async (t: TestContext) => {
  const root = fixture(t, readFixture('controllers/endpoint-decorators/merges-repeated-same-status-responses-in-nest-application-order-and-honors-ove/source.controller.ts'));
  const document = documentOf(await generateDocument(root, 'Repeated responses'));
  assert.equal(responseOf(document, '/repeated/merged', 'get', '400').description, 'second\n\nfirst');
  assert.equal(responseOf(document, '/repeated/override', 'get', '400').description, 'kept');
  assert.ok(responseOf(document, '/repeated/merged', 'get', '200'));
  assert.ok(responseOf(document, '/repeated/override', 'get', '200'));
  const cleared = responseOf(document, '/repeated/clear', 'get', '400');
  assert.equal(cleared.description, 'typed\n\ndescription only');
  assert.equal(cleared.content, undefined);
});

test('emits named 429, default, and 2XX range keys without replacing inferred success', async (t: TestContext) => {
  const root = fixture(t, readFixture('controllers/endpoint-decorators/emits-named-429-default-and-2xx-range-keys-without-replacing-inferred-success/source.controller.ts'));
  const document = documentOf(await generateDocument(root, 'Named responses'));
  const status = operationOf(document, '/named/status', 'get');
  assert.equal(responseOf(document, '/named/status', 'get', '429').description, 'slow down');
  assert.equal(expectValue(status.responses.default, 'default response').description, 'fallback');
  assert.equal(responseOf(document, '/named/status', 'get', '200').content?.['application/json']?.schema?.type, 'object');
  const range = operationOf(document, '/named/range', 'get');
  assert.equal(expectValue(range.responses['2XX'], '2XX response').description, 'success family');
  assert.equal(responseOf(document, '/named/range', 'get', '200').content?.['application/json']?.schema?.type, 'object');
  assert.deepEqual(expectValue(responseOf(document, '/named/manual', 'get', '2XX').content, 'manual 2XX content'), {
    'application/json': { schema: { type: 'string' } },
  });
});

test('rejects unreadable, invalid, and malformed Nest or Swagger statuses and unknown named helpers', async (t: TestContext) => {
  const cases = [
    `import { Controller, Get, HttpCode } from '@nestjs/common';
@Controller('invalid-http-code') export class InvalidHttpCodeController { @Get() @HttpCode(99) get(): void {} }`,
    `import { Controller, Get, HttpCode } from '@nestjs/common';
let STATUS = 204;
@Controller('unreadable-http-code') export class UnreadableHttpCodeController { @Get() @HttpCode(STATUS) get(): void {} }`,
    `import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
@Controller('invalid-swagger-status') export class InvalidSwaggerStatusController { @Get() @ApiResponse({ status: 700 }) get(): void {} }`,
    `import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
let STATUS = 200;
@Controller('unreadable-swagger-status') export class UnreadableSwaggerStatusController { @Get() @ApiResponse({ status: STATUS }) get(): void {} }`,
    `import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
@Controller('range-status') export class RangeStatusController {
  @Get() @ApiResponse({ status: '6XX' }) get(): void {}
}`,
    `import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
@Controller('lowercase-range') export class LowercaseRangeController {
  @Get() @ApiResponse({ status: '2xx' }) get(): void {}
}`,
    `import { Controller, Get, HttpCode } from '@nestjs/common';
@Controller('http-code-range') export class HttpCodeRangeController {
  @Get() @HttpCode('204') get(): void {}
}`,
  ];
  for (const source of cases) {
    const root = fixture(t, source);
    await assert.rejects(
      generateDocument(root, 'Invalid response status'),
      (error: unknown) => String(error).includes('NEST1309'),
    );
  }

  const unknownRoot = fixture(t, readFixture("controllers/endpoint-decorators/rejects-malformed-swagger-statuses-unknown-named-helpers-and-non-numeric-httpc/controller.ts"), {
    files: {
      'src/swagger-augment.ts': readFixture("controllers/endpoint-decorators/rejects-malformed-swagger-statuses-unknown-named-helpers-and-non-numeric-httpc/swagger-augment.ts"),
    },
  });
  await assert.rejects(
    generateDocument(unknownRoot, 'Unknown helper'),
    (error: unknown) => String(error).includes('NEST1309') && String(error).includes('ApiWidgetResponse'),
  );
});

test('writes a boolean response as one schema', async (t: TestContext) => {
  // protects: T-174 a boolean response is one schema, not an anyOf of two
  const root = fixture(t, `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

@Controller('flags')
export class FlagsController {
  @Get('boolean')
  @ApiOkResponse({ type: Boolean })
  flag(): boolean { return true; }

  @Get('optional')
  @ApiOkResponse({ type: Boolean })
  optional(): boolean | undefined { return undefined; }
}
`);
  const document = documentOf(await generateDocument(root, 'Flags'));
  assert.deepEqual(responseOf(document, '/flags/boolean', 'get', '200').content?.['application/json']?.schema, { type: 'boolean' });
  assert.deepEqual(responseOf(document, '/flags/optional', 'get', '200').content?.['application/json']?.schema, { type: 'boolean' });
});

test('gives a Swagger response, a bare @ApiNoContentResponse and a route with no response decorator an empty description', async (t: TestContext) => {
  // protects: T-175 a 404 with no description is not described as Success
  // protects: T-374 a route with no @ApiResponse has an empty 2xx description, as in Nest Swagger
  const root = fixture(t, `import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiResponse } from '@nestjs/swagger';

@Controller('described')
export class DescribedController {
  @Get('bare')
  @ApiNotFoundResponse()
  bare(): void {}

  @Get('named')
  @ApiResponse({ status: 404, description: 'Gone' })
  @ApiOkResponse({ description: 'Found' })
  named(): void {}

  @Get('plain')
  plain(): void {}

  @Post('gone')
  @HttpCode(204)
  @ApiNoContentResponse()
  gone(): void {}
}
`);
  const document = documentOf(await generateDocument(root, 'Described'));
  assert.equal(responseOf(document, '/described/bare', 'get', '404').description, '');
  assert.equal(responseOf(document, '/described/named', 'get', '404').description, 'Gone');
  assert.equal(responseOf(document, '/described/named', 'get', '200').description, 'Found');
  assert.equal(responseOf(document, '/described/plain', 'get', '200').description, '');
  assert.equal(responseOf(document, '/described/gone', 'post', '204').description, '');
});
