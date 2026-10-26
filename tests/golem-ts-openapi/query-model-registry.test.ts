// lane: typescript6 Checker guards: the controller generator runs the checker in this process
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runPipeline } from '#golem/cli';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

for (const openapiVersion of ['3.2.0', '3.1.2']) {
  test(`on OpenAPI ${openapiVersion} the operation codecs hold the model of a whole @Query() model, and golem check fails for a model they do not hold`, async (t) => {
    // protects: T-443 golem check verifies a whole @Query() model on OpenAPI 3.1, where the query flattens to primitive parameters
    const root = createControllerFixture(t, {
      prefix: 'golem-query-registry-',
      links: 'workspace',
      files: {
        'src/search.model.ts': "import type { IObject } from '@exprtlabs/golem/model';\nexport type TSearch = IObject<{ term: string; page?: number }>;\n",
        'src/a.controller.ts': "import { Controller, Get, Query } from '@nestjs/common';\nimport type { TSearch } from './search.model.js';\n@Controller('a')\nexport class AController {\n  @Get() list(@Query() search: TSearch): void {}\n}\n",
        'golem.yaml': `version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    openapiVersion: "${openapiVersion}"\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n`,
      },
    });
    const config = path.join(root, 'golem.yaml');
    await runPipeline(config);
    await runPipeline(config, { check: true });

    const registry = fs.readFileSync(path.join(root, 'src/generated/operation-codecs.ts'), 'utf8');
    assert.match(registry, /OPERATION_QUERY_CODECS = \{\s*"GET \/a": "TSearch_[0-9a-f]{8}"\s*\}/);
    assert.match(registry, /"AController\.list": \{\s*"query": "TSearch_[0-9a-f]{8}"\s*\}/);

    // A model that no generated operation holds still fails the check.
    fs.writeFileSync(path.join(root, 'src/other.model.ts'), "import type { IObject } from '@exprtlabs/golem/model';\nexport type TOther = IObject<{ term: string }>;\n");
    fs.writeFileSync(path.join(root, 'src/helper.controller.ts'), "import { Controller, Get, Query } from '@nestjs/common';\nimport type { TOther } from './other.model.js';\n@Controller('helper')\nexport class HelperController {\n  @Get() list(@Query() other: TOther): void {}\n}\n");
    await runPipeline(config);
    await assert.rejects(runPipeline(config, { check: true }), /RUNM1072 \(src\/helper\.controller\.ts:5:\d+\): @Query\(\) type TOther disagrees with generated operation keys/);
  });
}

test('on OpenAPI 3.1.2 a header model beside a whole @Query() model is no query codec', async (t) => {
  // protects: T-443 only a whole @Query() model names the query codec of an operation, not a flattened @Headers() model
  const root = createControllerFixture(t, {
    prefix: 'golem-query-registry-headers-',
    links: 'workspace',
    files: {
      'src/search.model.ts': "import type { IObject } from '@exprtlabs/golem/model';\nexport type TSearch = IObject<{ term: string; page?: number }>;\nexport type THeaders = IObject<{ token: string }>;\n",
      'src/a.controller.ts': "import { Controller, Get, Headers, Query } from '@nestjs/common';\nimport type { THeaders, TSearch } from './search.model.js';\n@Controller('a')\nexport class AController {\n  @Get() list(@Headers() headers: THeaders, @Query() search: TSearch): void {}\n  @Get('alone') alone(@Headers() headers: THeaders): void {}\n}\n",
      'golem.yaml': 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    openapiVersion: "3.1.2"\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n',
    },
  });
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });
  const registry = fs.readFileSync(path.join(root, 'src/generated/operation-codecs.ts'), 'utf8');
  assert.match(registry, /OPERATION_QUERY_CODECS = \{\s*"GET \/a": "TSearch_[0-9a-f]{8}"\s*\}/);
  assert.match(registry, /"AController\.alone": \{\s*\}/);
});

const CHECK_CONFIG = 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n';
const SEARCH_MODEL = "import type { IObject } from '@exprtlabs/golem/model';\nexport type TSearch = IObject<{ term: string; page?: number }>;\n";

test('golem check fails a @Query() model that only another operation holds, and passes a route inherited from a base class', async (t) => {
  // protects: T-446 golem check proves a @Query() model is the codec of its own operation, not that the model appears in some registry slot
  const root = createControllerFixture(t, {
    prefix: 'golem-query-registry-slot-',
    links: 'workspace',
    files: {
      'src/search.model.ts': SEARCH_MODEL,
      'src/base.ts': "import { Get, Query } from '@nestjs/common';\nimport type { TSearch } from './search.model.js';\nexport abstract class Base {\n  @Get('found') found(@Query() search: TSearch): void {}\n}\n",
      'src/a.controller.ts': "import { Body, Controller, Post } from '@nestjs/common';\nimport { Base } from './base.js';\nimport type { TSearch } from './search.model.js';\n@Controller('a')\nexport class AController extends Base {\n  @Post() create(@Body() search: TSearch): void {}\n}\n",
      'golem.yaml': CHECK_CONFIG,
    },
  });
  const config = path.join(root, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });
  const registry = fs.readFileSync(path.join(root, 'src/generated/operation-codecs.ts'), 'utf8');
  assert.match(registry, /"AController\.found": \{\s*"query": "TSearch_[0-9a-f]{8}"\s*\}/);

  // The model is the body of `create`, but no route holds it as the query of `helper`.
  fs.writeFileSync(path.join(root, 'src/a.controller.ts'), "import { Body, Controller, Post, Query } from '@nestjs/common';\nimport { Base } from './base.js';\nimport type { TSearch } from './search.model.js';\n@Controller('a')\nexport class AController extends Base {\n  @Post() create(@Body() search: TSearch): void {}\n  helper(@Query() search: TSearch): void {}\n}\n");
  await runPipeline(config);
  await assert.rejects(runPipeline(config, { check: true }), /RUNM1072 \(src\/a\.controller\.ts:7:\d+\): @Query\(\) type TSearch disagrees with generated operation keys/);
});

test('two controllers with one class name and one method name stop generation with NEST1313 and name both files, and a method with two paths is no clash', async (t) => {
  // protects: T-449 a same-named controller in another file must not replace a registry entry, which made golem check fail a correct site
  // protects: T-450 the message names both controller files relative to the working directory
  const controller = (model: string, operationId: string, className: string, routes: string) => `import { Body, Controller, Post } from '@nestjs/common';\nimport { ApiOperation } from '@nestjs/swagger';\nimport type { ${model} } from '../m.model.js';\n@Controller('${operationId}')\nexport class ${className} {\n  @ApiOperation({ operationId: '${operationId}' }) @Post(${routes}) create(@Body() body: ${model}): void {}\n}\n`;
  const root = createControllerFixture(t, {
    prefix: 'golem-registry-same-name-',
    links: 'workspace',
    files: {
      'src/m.model.ts': "import type { IObject } from '@exprtlabs/golem/model';\nexport type TOne = IObject<{ a: string }>;\nexport type TTwo = IObject<{ b: number }>;\n",
      'src/one/a.controller.ts': controller('TOne', 'createOne', 'AController', "['x', 'y']"),
      'src/two/a.controller.ts': controller('TTwo', 'createTwo', 'AController', ''),
      'golem.yaml': 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/one/a.controller.ts\n      - src/two/a.controller.ts\n    output: generated/api.json\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n',
    },
  });
  const config = path.join(root, 'golem.yaml');
  await assert.rejects(runPipeline(config), (error: Error) => {
    assert.match(error.message, /src\/two\/a\.controller\.ts:6:\d+: ERROR NEST1313: AController\.create is declared in both .*src\/one\/a\.controller\.ts and .*src\/two\/a\.controller\.ts\. .* Rename one controller class\./);
    const relative = (file: string): string => path.relative(process.cwd(), path.join(root, file));
    assert.ok(error.message.includes(`declared in both ${relative('src/one/a.controller.ts')} and ${relative('src/two/a.controller.ts')}.`));
    assert.ok(error.message.includes(`${relative('src/two/a.controller.ts')}:6:`));
    return true;
  });

  fs.writeFileSync(path.join(root, 'src/two/a.controller.ts'), controller('TTwo', 'createTwo', 'BController', ''));
  await runPipeline(config);
  await runPipeline(config, { check: true });
  const registry = fs.readFileSync(path.join(root, 'src/generated/operation-codecs.ts'), 'utf8');
  assert.match(registry, /"AController\.create": \{\s*"input": "TOne_[0-9a-f]{8}"\s*\},\s*"BController\.create": \{\s*"input": "TTwo_[0-9a-f]{8}"\s*\}/);
});
