// lane: typescript6 Checker guards: the controller generator runs the checker in this process
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

const MODEL = `import type { IModel, IObject } from '@exprtlabs/golem/model';
export type TPayment = IModel<{ id: string; amount: number }>;
export type TFilter = IObject<{ status: string; limit?: number }>;
`;

function project(t: TestContext, methods: string, openapiVersion = '3.2.0'): string {
  return createControllerFixture(t, {
    prefix: 'golem-one-field-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': MODEL,
      'src/a.controller.ts': `import { Body, Controller, Get, Post, Query } from '@nestjs/common';\nimport type { TPayment, TFilter } from './payment.model.js';\n@Controller('a')\nexport class AController {\n${methods}\n}\n`,
      'golem.yaml': `version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    openapiVersion: "${openapiVersion}"\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n`,
    },
  });
}

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

interface Operation { readonly parameters?: readonly Record<string, unknown>[]; readonly requestBody?: { readonly required?: boolean; readonly content: Record<string, { readonly schema: Record<string, unknown> }> } }

for (const openapiVersion of ['3.2.0', '3.1.2']) {
  test(`a one-field model @Body and @Query reach the OpenAPI ${openapiVersion} document and the operation codecs, and golem check agrees with the rewrite`, async (t) => {
    // protects: R-13 T-323 the one-field model parameter the interceptor converts is described by the controllers job
    const root = project(t, [
      "  @Post() create(@Body('payment') payment: TPayment): void {}",
      "  @Get() list(@Query('filter') filter: TFilter): void {}",
    ].join('\n'), openapiVersion);
    const config = path.join(root, 'golem.yaml');
    await runPipeline(config);
    await runPipeline(config, { check: true });

    const document = JSON.parse(read(root, 'generated/api.json')) as { paths: Record<string, Record<string, Operation>> };
    const post = document.paths['/a']!.post!;
    const bodySchema = post.requestBody!.content['application/json']!.schema;
    assert.equal(post.requestBody!.required, true);
    assert.deepEqual({ ...bodySchema, properties: Object.keys(bodySchema.properties as object) }, { type: 'object', properties: ['payment'], required: ['payment'] });
    assert.match(JSON.stringify((bodySchema.properties as Record<string, unknown>).payment), /TPayment/);
    assert.equal(post.parameters, undefined, 'a body field is no OpenAPI parameter');

    const filter = document.paths['/a']!.get!.parameters!.find(parameter => parameter.name === 'filter')!;
    assert.deepEqual({ in: filter.in, style: filter.style, explode: filter.explode, required: filter.required }, { in: 'query', style: 'deepObject', explode: true, required: true });
    assert.match(JSON.stringify(filter.schema), /TFilter/);

    const registry = read(root, 'src/generated/operation-codecs.ts');
    assert.match(registry, /"AController\.create": \{\s*"fields": \{\s*"body:payment": "TPayment_[0-9a-f]{8}"/);
    assert.match(registry, /"AController\.list": \{\s*"fields": \{\s*"query:filter": "TFilter_[0-9a-f]{8}"/);
  });
}

test('a one-field @Body of another type, a whole and a one-field @Body together, and a repeated field are refused', async (t) => {
  // protects: R-13 T-323 the controllers job refuses what NestModelInterceptor throws for
  const cases: readonly (readonly [string, string])[] = [
    ["  @Post() a(@Body('note') note: string): void {}", 'NEST1103'],
    ["  @Post() a(@Body() whole: TPayment, @Body('payment') payment: TPayment): void {}", 'NEST1103'],
    ["  @Post() a(@Body('payment') payment: TPayment, @Body() whole: TPayment): void {}", 'NEST1103'],
    ["  @Post() a(@Body('payment') one: TPayment, @Body('payment') two: TPayment): void {}", 'NEST1312'],
    ["  @Get() a(@Query('when') when: Date): void {}", 'NEST1107'],
  ];
  for (const [methods, code] of cases) {
    await assert.rejects(runPipeline(path.join(project(t, methods), 'golem.yaml')), new RegExp(`${code}`), methods);
  }
});
