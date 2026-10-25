// lane: typescript6 Checker guards: the controller generator and the rewrite code it uses run the checker in this process
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#controllers/generator';
import { formatOpenApiProblems, validateOpenApiDocument } from '#openapi/openapi-validator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

type Version = '3.2.0' | '3.1.2';

const VERSIONS: readonly Version[] = ['3.2.0', '3.1.2'];

const SECURITY_SCHEMES = {
  bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  'api-key': { type: 'apiKey', name: 'x-api-key', in: 'header' },
  basic: { type: 'http', scheme: 'basic' },
  oauth: {
    type: 'oauth2',
    flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: { read: 'Read access' } } },
  },
  oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://auth.example.com/.well-known/openid-configuration' },
};

const CONTROLLERS: Readonly<Record<string, string>> = {
  parameters: `import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { ApiHeader, ApiParam, ApiProperty, ApiQuery } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/golem/model';

class SearchDto { @ApiProperty({ description: 'Search term' }) term!: string; @ApiProperty({ required: false }) page?: number; }
export type TFilter = IModel<{ limit: number; cursor?: string }>;

@Controller('parameters')
export class ParametersController {
  @Get('plain/:id')
  @ApiParam({ name: 'id', description: 'Item id' })
  @ApiQuery({ name: 'sort', required: false, enum: ['asc', 'desc'] })
  @ApiHeader({ name: 'x-trace', required: false })
  plain(@Param('id') id: string, @Query('sort') sort: string, @Query('limit') limit = '20', @Headers('x-trace') trace?: string): void {}

  @Get('dto')
  @ApiQuery({ name: 'term', description: 'Search term' })
  dto(@Query() search: SearchDto): void {}

  @Get('model')
  model(@Query() filter: TFilter): void {}

  @Get('files{/:name}')
  optional(@Param('name') name?: string): void {}
}
`,
  responses: `import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiProperty, ApiResponse } from '@nestjs/swagger';

class ItemDto { @ApiProperty({ description: 'Identifier' }) id!: string; @ApiProperty({ required: false }) note?: string; }

@Controller('responses')
export class ResponsesController {
  @Get('one')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'The item', type: ItemDto })
  one(): ItemDto { return { id: 'a' }; }

  @Get('many')
  @ApiResponse({ status: 200, description: 'Items', type: [ItemDto] })
  @ApiResponse({ status: 404, description: 'Missing' })
  many(): ItemDto[] { return []; }

  @Post('create')
  @HttpCode(201)
  @Header('Content-Type', 'application/vnd.api+json')
  @ApiCreatedResponse({ description: 'Created', type: ItemDto })
  create(): ItemDto { return { id: 'a' }; }

  @Get('empty')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Nothing' })
  empty(): void {}
}
`,
  security: `import { Controller, Get } from '@nestjs/common';
import { ApiBasicAuth, ApiBearerAuth, ApiOAuth2, ApiSecurity } from '@nestjs/swagger';

@ApiBearerAuth()
@Controller('security')
export class SecurityController {
  @Get('bearer')
  bearer(): void {}

  @Get('key')
  @ApiSecurity('api-key')
  key(): void {}

  @Get('basic')
  @ApiBasicAuth('basic')
  basic(): void {}

  @Get('oauth')
  @ApiOAuth2(['read'], 'oauth')
  oauth(): void {}

  @Get('oidc')
  @ApiSecurity('oidc')
  oidc(): void {}
}
`,
  'shared models': `import { Body, Controller, Get, Post } from '@nestjs/common';
import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';

export type TAddress = IObject<{ street: string & MinLength<3>; city?: string }>;
export type TCustomer = IModel<{ name: string; address: TAddress; aliases: string[]; history: TAddress[] }>;

@Controller('customers')
export class CustomersController {
  @Post()
  create(@Body() input: TCustomer): TCustomer { return input; }

  @Get()
  list(): TCustomer[] { return []; }
}
`,
  'discriminated unions': `import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';

export type TCircle = IModel<{ kind: 'circle'; radius: number }>;
export type TRect = IModel<{ kind: 'rect'; width: number }>;
export type TDrawing = IModel<{ shape: TCircle | TRect; mixed: TCircle | { kind: 'label'; text: string }; maybe: TCircle | null }>;

@Controller('drawings')
export class DrawingsController {
  @Post()
  create(@Body() body: TDrawing): TDrawing { return body; }
}
`,
  metadata: `import { Body, Controller, Delete, Get, Head, Options, Patch, Post, Put, Query, Sse } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeaders, ApiHideProperty, ApiOperation, ApiParam, ApiProduces, ApiProperty, ApiPropertyOptional, ApiResponse, ApiSchema, ApiTags } from '@nestjs/swagger';

enum Colour { Red = 'red', Blue = 'blue' }
enum Level { Low = 1, High = 2 }

@ApiSchema({ name: 'Widget', description: 'A widget' })
class WidgetDto {
  @ApiProperty({ format: 'uuid', example: '3fa85f64-5717-4562-b3fc-2c963f66afa6', description: 'Id' }) id!: string;
  @ApiProperty({ minimum: 1, maximum: 10, default: 3 }) size!: number;
  @ApiProperty({ minLength: 2, maxLength: 8, pattern: '^[a-z]+$' }) code!: string;
  @ApiProperty({ enum: Colour }) colour!: Colour;
  @ApiProperty({ enum: Level, enumName: 'Level' }) level!: Level;
  @ApiProperty({ type: [String], isArray: true, minItems: 1 }) tags!: string[];
  @ApiPropertyOptional({ deprecated: true }) legacy?: string;
  @ApiProperty() created!: Date;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } }) scores!: Record<string, number>;
  @ApiProperty({ nullable: true, type: String }) middle!: string | null;
  @ApiHideProperty() secret!: string;
}

@ApiTags('metadata')
@Controller('metadata')
export class MetadataController {
  @Post()
  @ApiOperation({ summary: 'Create', description: 'Creates a widget', deprecated: true })
  @ApiConsumes('application/json', 'application/xml')
  @ApiProduces('application/json')
  @ApiBody({ type: WidgetDto, description: 'The widget', required: true })
  @ApiHeaders([{ name: 'x-request-id', required: true, description: 'Request id' }])
  @ApiResponse({ status: 201, description: 'Made', type: WidgetDto, headers: { 'x-rate': { description: 'Rate', schema: { type: 'integer' } } } })
  create(@Body() body: WidgetDto): WidgetDto { return body; }

  @Put(':id') @ApiParam({ name: 'id', type: Number }) put(@Body() body: WidgetDto[]): void {}
  @Patch() patch(@Body() body: Partial<WidgetDto>): void {}
  @Delete() remove(): void {}
  @Head() head(): void {}
  @Options() options(): void {}
  @Get('level') @ApiResponse({ status: 200, enum: Level }) level(@Query('level') level: Level, @Query('tags') tags: string[]): Level { return level; }
  @Get('tuple') tuple(): [string, number] { return ['a', 1]; }
  @Get('nested') nested(): Promise<{ widgets: WidgetDto[]; total: number; next?: string | null }> { return Promise.resolve({ widgets: [], total: 0 }); }
}
`,
  overlays: `import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiQuery } from '@nestjs/swagger';
import type { IModel } from '@exprtlabs/golem/model';

class ResultDto {
  @ApiProperty({ nullable: true }) label!: string;
  @ApiProperty({ enum: ['cat', 'dog'], nullable: true }) kind!: 'cat' | 'dog';
}
export type TPayment = IModel<{ id: string }>;
export type TFilter = IModel<{ limit: number }>;

@Controller('overlays')
export class OverlaysController {
  @Get('nullable')
  @ApiOkResponse({ schema: { nullable: true } })
  nullable(): ResultDto { return { label: 'ok', kind: 'cat' }; }

  @Get('payment')
  @ApiOkResponse({ content: { 'application/json': { example: { id: 'p-1' } } } })
  payment(): TPayment { return { id: 'p-1' }; }

  @Get('filtered')
  @ApiQuery({ name: 'limit', description: 'Page size' })
  filtered(@Query() filter: TFilter): void {}
}
`,
};

for (const [name, source] of Object.entries(CONTROLLERS)) {
  for (const openapiVersion of VERSIONS) {
    test(`the ${name} document passes the official OpenAPI check on ${openapiVersion}`, async t => {
      // protects: F-163 golem-ts-openapi output passes the official OpenAPI schema check on both versions
      const root = createControllerFixture(t, {
        prefix: 'golem-ts-openapi-official-schema-',
        packageName: 'golem-ts-openapi-official-schema-fixture',
        source,
      });
      const result = await generate({
        root,
        output: path.join(root, 'openapi.json'),
        openapiVersion,
        info: { title: 'Official schema', version: '1' },
        securitySchemes: SECURITY_SCHEMES,
        servers: [{ url: 'https://api.example.com/{base}', description: 'Production', variables: { base: { default: 'v1', enum: ['v1', 'v2'] } } }],
        tags: [{ name: 'metadata', description: 'Metadata', externalDocs: { url: 'https://example.com/docs' } }],
        profile: { mobx: false, validation: false },
      });
      const artifact = result.artifacts[0];
      assert.ok(artifact);
      const problems = validateOpenApiDocument(JSON.parse(artifact.content));
      assert.deepEqual(problems, [], formatOpenApiProblems(problems, pointer => pointer));
    });
  }
}
