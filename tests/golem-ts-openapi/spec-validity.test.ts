import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

interface OpenApiParameter {
  readonly in?: string;
  readonly name?: string;
  readonly required?: boolean;
  readonly description?: string;
  readonly content?: Readonly<Record<string, { readonly schema?: OpenApiSchema }>>;
}

interface OpenApiSchema {
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, { readonly description?: string; readonly enum?: readonly unknown[] }>>;
}

interface OpenApiOperation {
  readonly operationId?: string;
  readonly tags?: readonly string[];
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly responses: Readonly<Record<string, {
    readonly headers?: Readonly<Record<string, { readonly example?: unknown; readonly schema?: unknown }>>;
    readonly content?: Readonly<Record<string, unknown>>;
  }>>;
}

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
}

type GenerateOptions = Omit<Parameters<typeof generate>[0], 'root' | 'output' | 'info' | 'profile'>;

const HEADER = "import { All, Controller, Get, Headers, Header, Param, Query, Redirect, RequestMapping, RequestMethod, Search, Sse, VERSION_NEUTRAL } from '@nestjs/common';\n"
  + "import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';\n"
  + 'class FilterDto { @ApiProperty() term?: string; @ApiProperty() page?: string; }\n'
  + 'class ItemDto { @ApiProperty() id!: string; }\n';

function fixture(t: TestContext, body: string): string {
  return createControllerFixture(t, {
    prefix: 'golem-ts-openapi-spec-validity-',
    packageName: 'golem-ts-openapi-spec-validity-fixture',
    source: `${HEADER}${body}\n`,
  });
}

function generateAt(root: string, options: GenerateOptions = {}): ReturnType<typeof generate> {
  return generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Spec validity', version: '1' },
    profile: { mobx: false, validation: false },
    ...options,
  });
}

async function documentOf(t: TestContext, body: string, options: GenerateOptions = {}): Promise<OpenApiDocument> {
  const result = await generateAt(fixture(t, body), options);
  const artifact = result.artifacts[0];
  assert.ok(artifact);
  return JSON.parse(artifact.content) as OpenApiDocument;
}

function codesOf(error: unknown): readonly string[] {
  if (error === null || typeof error !== 'object' || !('diagnostics' in error)) return [];
  const diagnostics = (error as { readonly diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics)
    ? diagnostics.map(item => String((item as { readonly code?: unknown }).code))
    : [];
}

async function rejects(t: TestContext, body: string, code: string, options: GenerateOptions = {}): Promise<void> {
  await assert.rejects(() => generateAt(fixture(t, body), options), (error: unknown) => codesOf(error).includes(code), body);
}

function parameter(operation: OpenApiOperation | undefined, location: string, name: string): OpenApiParameter | undefined {
  return operation?.parameters?.find(item => item.in === location && item.name === name);
}

test('rejects two parameters with the same name and location in one operation', async t => {
  await rejects(t, "@Controller('dup') export class DupController { @Get() list(@Query('page') a: string, @Query('page') b: string): void {} }", 'NEST1312');
  await rejects(t, "@Controller('dup-flat') export class DupFlatController { @Get() list(@Query() filter: FilterDto, @Query('page') page: string): void {} }", 'NEST1312', { openapiVersion: '3.1.2' });
  const document = await documentOf(t, "@Controller('same-name') export class SameNameController { @Get() list(@Query('id') q: string, @Headers('id') h: string): void {} }");
  const operation = document.paths['/same-name']?.get;
  assert.ok(parameter(operation, 'query', 'id'));
  assert.ok(parameter(operation, 'header', 'id'));
});

test('never mixes an OpenAPI 3.2 querystring parameter with query parameters', async t => {
  await rejects(t, "@Controller('mixed') export class MixedController { @Get() list(@Query() filter: FilterDto, @Query('cursor') cursor: string): void {} }", 'NEST1107');
  await rejects(t, "@Controller('mixed-api') export class MixedApiController { @Get() @ApiQuery({ name: 'cursor' }) list(@Query() filter: FilterDto): void {} }", 'NEST1107');
  await rejects(t, "@Controller('two-dtos') export class TwoDtosController { @Get() list(@Query() a: FilterDto, @Query() b: FilterDto): void {} }", 'NEST1107');
});

test('applies Swagger parameter overrides by name and location', async t => {
  const document = await documentOf(t, [
    "@Controller('items') export class ItemsController {",
    "  @Get(':id') @ApiParam({ name: 'id', description: 'path id' }) @ApiQuery({ name: 'id', description: 'query id' }) @ApiHeader({ name: 'id', description: 'header id' })",
    "  get(@Param('id') id: string, @Query('id') q: string, @Headers('id') h: string): void {}",
    '}',
  ].join('\n'));
  const operation = document.paths['/items/{id}']?.get;
  assert.equal(parameter(operation, 'path', 'id')?.description, 'path id');
  assert.equal(parameter(operation, 'query', 'id')?.description, 'query id');
  assert.equal(parameter(operation, 'header', 'id')?.description, 'header id');
});

test('rejects path-to-regexp syntax that has no OpenAPI path form', async t => {
  for (const route of ['files/:id(\\\\d+)', 'files*', 'files/*splat', 'a/:"quoted-name"', '{/*rest}']) {
    await rejects(t, `@Controller('paths') export class PathsController { @Get('${route}') get(): void {} }`, 'NEST1207');
  }
});

test('expands optional path segments into one operation per path and keeps other literal characters', async t => {
  const document = await documentOf(t, [
    "@Controller('opt') export class OptController {",
    "  @Get(':id?') legacy(@Param('id') id?: string): void {}",
    "  @Get('files{/:name}') modern(@Param('name') name?: string): void {}",
    "  @Get('range/:a-:b') range(@Param('a') a: string, @Param('b') b: string): void {}",
    "  @Get('doc/:id.json') json(@Param('id') id: string): void {}",
    "  @Get('@me') me(): void {}",
    '}',
  ].join('\n'));
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/opt', '/opt/@me', '/opt/doc/{id}.json', '/opt/files', '/opt/files/{name}', '/opt/range/{a}-{b}', '/opt/{id}',
  ]);
  assert.equal(document.paths['/opt']?.get?.operationId, 'OptController_legacy__path_2');
  assert.equal(document.paths['/opt/{id}']?.get?.operationId, 'OptController_legacy__path_1');
  assert.equal(parameter(document.paths['/opt']?.get, 'path', 'id'), undefined);
  assert.equal(parameter(document.paths['/opt/{id}']?.get, 'path', 'id')?.required, true);
  assert.equal(parameter(document.paths['/opt/files/{name}']?.get, 'path', 'name')?.required, true);
  assert.ok(parameter(document.paths['/opt/range/{a}-{b}']?.get, 'path', 'b'));
});

test('treats VERSION_NEUTRAL in @Controller({ version }) as an unversioned path', async t => {
  const document = await documentOf(
    t,
    "@Controller({ path: 'things', version: [VERSION_NEUTRAL, '1'] }) export class ThingsController { @Get() list(): void {} }",
    { uriVersioning: { type: 'URI', prefix: 'v' } },
  );
  assert.deepEqual(Object.keys(document.paths).sort(), ['/things', '/v1/things']);
});

test('defaults @ApiQuery-only parameters to required and parameters with initializers to optional', async t => {
  const document = await documentOf(t, [
    "@Controller('pages') export class PagesController {",
    "  @Get() @ApiQuery({ name: 'cursor' }) @ApiQuery({ name: 'sort', required: false }) @ApiHeader({ name: 'x-trace' })",
    "  list(@Query('limit') limit = '20'): void {}",
    '}',
  ].join('\n'));
  const operation = document.paths['/pages']?.get;
  assert.equal(parameter(operation, 'query', 'cursor')?.required, true);
  assert.equal(parameter(operation, 'query', 'sort')?.required, false);
  assert.equal(parameter(operation, 'header', 'x-trace')?.required, false);
  assert.equal(parameter(operation, 'query', 'limit')?.required, false);
});

test('an @ApiQuery without required makes a declared optional query parameter required, as @nestjs/swagger does', async t => {
  const document = await documentOf(t, "@Controller('opt-q') export class OptQueryController { @Get() @ApiQuery({ name: 'x' }) list(@Query('x') x?: string): void {} }");
  assert.equal(parameter(document.paths['/opt-q']?.get, 'query', 'x')?.required, true);
});

test('skips excluded endpoints before validating their route decorator and path', async t => {
  const document = await documentOf(t, [
    "@Controller('ex') export class ExcludedController {",
    "  @Get('*') @ApiExcludeEndpoint() catchAll(): void {}",
    "  @All('*') @ApiExcludeEndpoint() anyMethod(): void {}",
    "  @Sse('events') @ApiOperation({ hidden: true }) events(): void {}",
    "  @Get('ok') ok(): void {}",
    '}',
  ].join('\n'));
  assert.deepEqual(Object.keys(document.paths), ['/ex/ok']);
});

test('uses @Header Content-Type as the success media type and keeps other headers', async t => {
  const document = await documentOf(t, "@Controller('media') export class MediaController { @Get() @Header('Content-Type', 'application/vnd.api+json') @Header('Set-Cookie', 'a=b') get(): ItemDto { return { id: 'x' }; } }");
  const response = document.paths['/media']?.get?.responses['200'];
  assert.deepEqual(Object.keys(response?.content ?? {}), ['application/vnd.api+json']);
  assert.deepEqual(Object.keys(response?.headers ?? {}), ['Set-Cookie']);
});

test('routes @ApiQuery metadata for a query DTO property the same way in OpenAPI 3.2 and 3.1.2', async t => {
  const body = "@Controller('dto') export class DtoController { @Get() @ApiQuery({ name: 'term', description: 'Search term', enum: ['a', 'b'] }) list(@Query() filter: FilterDto): void {} }";
  const modern = (await documentOf(t, body)).paths['/dto']?.get;
  assert.equal(modern?.parameters?.length, 1);
  const querystring = modern?.parameters?.[0];
  assert.equal(querystring?.in, 'querystring');
  const schema = querystring?.content?.['application/x-www-form-urlencoded']?.schema;
  assert.equal(schema?.properties?.term?.description, 'Search term');
  assert.deepEqual(schema?.properties?.term?.enum, ['a', 'b']);
  assert.deepEqual(schema?.required, ['term']);
  const legacy = (await documentOf(t, body, { openapiVersion: '3.1.2' })).paths['/dto']?.get;
  const term = parameter(legacy, 'query', 'term');
  assert.equal(term?.description, 'Search term');
  assert.equal(term?.required, true);
});

test('supports @RequestMapping with an OpenAPI method and rejects ALL or non-OpenAPI methods', async t => {
  const document = await documentOf(t, [
    "@Controller('rm') export class MappingController {",
    "  @RequestMapping({ path: 'create', method: RequestMethod.POST }) create(): void {}",
    '  @RequestMapping() index(): void {}',
    '}',
  ].join('\n'));
  assert.ok(document.paths['/rm/create']?.post);
  assert.ok(document.paths['/rm']?.get);
  await rejects(t, "@Controller('rm-all') export class MappingAllController { @RequestMapping({ path: 'x', method: RequestMethod.ALL }) any(): void {} }", 'NEST1201');
  await rejects(t, "@Controller('rm-search') export class MappingSearchController { @RequestMapping({ path: 'x', method: RequestMethod.SEARCH }) find(): void {} }", 'NEST1201');
});

test('rejects redirects and non-OpenAPI methods in any decorator order and documents @Header response headers', async t => {
  await rejects(t, "@Controller('r1') export class R1Controller { @Get('a') @Redirect('https://example.com') get(): void {} }", 'NEST1201');
  await rejects(t, "@Controller('r2') export class R2Controller { @Redirect('https://example.com') @Get('a') get(): void {} }", 'NEST1201');
  await rejects(t, "@Controller('s') export class SearchController { @Search('a') find(): void {} }", 'NEST1201');
  const document = await documentOf(t, "@Controller('cached') export class CachedController { @Get() @Header('Cache-Control', 'no-store') get(): void {} }");
  const header = document.paths['/cached']?.get?.responses['200']?.headers?.['Cache-Control'];
  assert.deepEqual(header, { example: 'no-store', schema: { type: 'string' } });
});

test('merges class tags and security along the controller chain with method security, as @nestjs/swagger does', async t => {
  const document = await documentOf(t, [
    "@ApiTags('base') @ApiBearerAuth() class BaseController {}",
    "@Controller('chain') @ApiTags('derived') export class ChainController extends BaseController {",
    "  @Get() @ApiTags('method') @ApiSecurity('api-key') get(): void {}",
    '}',
  ].join('\n'), {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
      'api-key': { type: 'apiKey', name: 'x-api-key', in: 'header' },
    },
  });
  const operation = document.paths['/chain']?.get;
  assert.deepEqual(operation?.tags, ['base', 'derived', 'method']);
  assert.deepEqual(operation?.security, [{ bearer: [] }, { 'api-key': [] }]);
});

test('reads class tags and security from a decorated base reached through a mixin', async t => {
  const document = await documentOf(t, [
    "@ApiTags('base') @ApiBearerAuth() class BaseController {}",
    'type Constructor = new (...args: any[]) => object;',
    'function Timestamped<TBase extends Constructor>(Base: TBase) { class Mixed extends Base {} return Mixed; }',
    "@Controller('mixin') @ApiTags('derived') export class MixinController extends Timestamped(BaseController) {",
    '  @Get() get(): void {}',
    '}',
  ].join('\n'), { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } });
  const operation = document.paths['/mixin']?.get;
  assert.deepEqual(operation?.tags, ['base', 'derived']);
  assert.deepEqual(operation?.security, [{ bearer: [] }]);
});

test('orders paths by code unit rather than by the host locale', async t => {
  const document = await documentOf(t, [
    "@Controller() export class OrderController {",
    "  @Get('apple') apple(): void {}",
    "  @Get('Zebra') zebra(): void {}",
    "  @Get('\u00e9clair') eclair(): void {}",
    '}',
  ].join('\n'));
  // Code units: 'Z' (0x5a) < 'a' (0x61) < 'é' (0xe9); a locale collation would put apple and éclair before Zebra.
  assert.deepEqual(Object.keys(document.paths), ['/Zebra', '/apple', '/\u00e9clair']);
});
