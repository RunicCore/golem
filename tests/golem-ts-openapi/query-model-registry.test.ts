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
