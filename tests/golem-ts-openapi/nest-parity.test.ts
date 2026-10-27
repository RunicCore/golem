import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

interface Doc {
  readonly openapi: string;
  readonly servers?: readonly Record<string, unknown>[];
  readonly paths: Record<string, Record<string, {
  readonly tags?: readonly string[];
  readonly security?: readonly Record<string, unknown>[];
  readonly responses: Record<string, { readonly content: Record<string, { readonly schema: { readonly properties: Record<string, unknown>; readonly required: readonly string[] } }> }>;
}>>;
  readonly components?: { readonly schemas?: Record<string, { readonly properties?: Record<string, Record<string, unknown>>; readonly required?: readonly string[] }> };
}

const IMPORTS = `import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBasicAuth, ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/golem/model';
`;

async function build(
  t: TestContext,
  source: string,
  options: { readonly openapiVersion?: '3.1.2' | '3.2.0'; readonly servers?: readonly Record<string, unknown>[] } = {},
): Promise<Doc> {
  const root = createControllerFixture(t, { prefix: 'golem-ts-openapi-parity-', packageName: 'golem-ts-openapi-parity-fixture', sourceFile: 'src/items.controller.ts', source: `${IMPORTS}${source}` });
  const result = await generate({
    root,
    output: path.join(root, 'openapi.json'),
    info: { title: 'Items', version: '1' },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, basic: { type: 'http', scheme: 'basic' } },
    profile: { mobx: false, validation: false },
    ...options,
  });
  return JSON.parse(result.artifacts[0]!.content) as Doc;
}

async function rejection(promise: Promise<unknown>): Promise<{ readonly codes: readonly unknown[]; readonly text: string }> {
  try {
    await promise;
  } catch (error) {
    const diagnostics = (error as { readonly diagnostics?: readonly { readonly code?: unknown }[] }).diagnostics ?? [];
    return { codes: diagnostics.map(item => item.code), text: String(error) };
  }
  assert.fail('expected generation to be refused');
}

test('a string that only looks like a component path adds no component', async t => {
  // protects: T-493 a description is not a reference, so TUnused stays out of the document
  const document = await build(t, `
export type TUsed = IModel<{ id: string }>;
export type TUnused = IModel<{ id: string }>;
@Controller('items')
export class ItemsController {
  @Get()
  @ApiOperation({ description: '#/components/schemas/TUnused' })
  list(): TUsed { return { id: 'a' }; }
}
`);
  assert.deepEqual(Object.keys(document.components?.schemas ?? {}), ['TUsed']);
});

test('an example object that holds a $ref key is not a reference, and a discriminator mapping target must exist', async t => {
  // protects: T-493 only $ref and discriminator.mapping values are references
  const document = await build(t, `
class Sample {
  @ApiProperty({ example: { $ref: '#/components/schemas/Missing' } }) sample!: Record<string, string>;
}
@Controller('items')
export class ItemsController {
  @Get() list(): Sample { return { sample: {} }; }
}
`);
  const sample = document.paths['/items']!.get!.responses['200']!.content['application/json']!.schema.properties.sample as { readonly example: unknown };
  assert.deepEqual(sample.example, { $ref: '#/components/schemas/Missing' });
  const refused = await rejection(build(t, `
class Pet {
  @ApiProperty({ oneOf: [{ type: 'string' }], discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Missing' } } }) pet!: string;
}
@Controller('items')
export class ItemsController {
  @Get() list(): Pet { return { pet: 'a' }; }
}
`));
  assert.ok(refused.codes.includes('NEST1505'), refused.text);
  assert.match(refused.text, /#\/components\/schemas\/Missing/);
});

const ITEM = 'export type TItem = IModel<{ id: string }>;\n';
const SOURCE = `${ITEM}@Controller('items') export class ItemsController { @Get() list(): TItem { return { id: 'a' }; } }`;

test('a server name is written on OpenAPI 3.2.0 and refused on 3.1.2', async t => {
  // protects: T-493 OAS 3.2 server objects carry a name; 3.1 has none
  const servers = [{ url: 'https://api.example.test', name: 'production' }];
  const document = await build(t, SOURCE, { servers });
  assert.deepEqual(document.servers, servers);
  const refused = await rejection(build(t, SOURCE, { servers, openapiVersion: '3.1.2' }));
  assert.ok(refused.codes.includes('NEST1403'), refused.text);
  assert.match(refused.text, /servers\[0\] contains unsupported property "name"/);
});

test('a controller method with a quoted or computed name and a route decorator is reported, not dropped', async t => {
  // protects: T-493 a route method the analysis cannot name is a diagnostic, not a missing operation
  const quoted = await rejection(build(t, `${ITEM}@Controller('items') export class ItemsController { @Get() 'list-items'(): TItem { return { id: 'a' }; } }`));
  assert.ok(quoted.codes.includes('NEST1201'), quoted.text);
  assert.match(quoted.text, /list-items.*identifier/);
  const computed = await rejection(build(t, `${ITEM}const NAME = 'list';\n@Controller('items') export class ItemsController { @Get() [NAME](): TItem { return { id: 'a' }; } }`));
  assert.ok(computed.codes.includes('NEST1201'), computed.text);
  assert.match(computed.text, /\[NAME\].*identifier/);
});

test('stacked tags and security follow the order Nest applies them, bottom decorator first', async t => {
  // protects: T-493 stacked @ApiTags and @ApiBearerAuth lists match @nestjs/swagger, class and method alike
  const document = await build(t, `${ITEM}
@ApiTags('c1') @ApiTags('c2') @ApiBearerAuth() @ApiBasicAuth()
@Controller('items')
export class ItemsController {
  @ApiTags('m1') @ApiTags('m2') @ApiBearerAuth() @ApiBasicAuth() @Get()
  list(): TItem { return { id: 'a' }; }
}
`);
  const operation = document.paths['/items']!.get!;
  assert.deepEqual(operation.tags, ['c2', 'c1', 'm2', 'm1']);
  assert.deepEqual(operation.security, [{ basic: [] }, { bearer: [] }, { basic: [] }, { bearer: [] }]);
});

test('a second whole @Body() is reported like a mixed @Body', async t => {
  // protects: T-493 a second whole body must not silently replace the first
  const refused = await rejection(build(t, `
export type TA = IModel<{ a: string }>;
export type TB = IModel<{ b: string }>;
@Controller('items')
export class ItemsController {
  @Post() create(@Body() first: TA, @Body() second: TB): TA { return first; }
}
`));
  assert.ok(refused.codes.includes('NEST1103'), refused.text);
  assert.match(refused.text, /second whole @Body\(\)/);
});

test('@ApiProperty({ type: String }) on string | null keeps the type String and drops null, as Nest does', async t => {
  // protects: T-493 user decision: read @ApiProperty and match @nestjs/swagger, where nullable is explicit
  const document = await build(t, `
class Holder {
  @ApiProperty({ type: String }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) alias!: string | null;
}
@Controller('items')
export class ItemsController {
  @Get() list(): Holder { return { name: null, alias: null }; }
}
`);
  const holder = document.paths['/items']!.get!.responses['200']!.content['application/json']!.schema;
  assert.deepEqual(holder.properties, { alias: { type: ['string', 'null'] }, name: { type: 'string' } });
  assert.deepEqual(holder.required, ['alias', 'name']);
});
