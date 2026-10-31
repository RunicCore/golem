// lane: typescript6 Checker guards: the controller generator runs the checker in this process
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

interface Document { readonly paths: Record<string, { readonly post: { readonly requestBody: { readonly content: Record<string, { readonly schema: Record<string, unknown> }> } } }> }

/** A project of one controller over one model; `decorators` is a source file of `src/decorators.ts`. */
async function bodySchema(t: TestContext, decorators: string, method: string): Promise<Record<string, unknown>> {
  const root = createControllerFixture(t, {
    prefix: 'golem-parameter-decorators-',
    links: 'workspace',
    files: {
      'src/payment.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TPayment = IModel<{ id: string }>;\n",
      'src/decorators.ts': decorators,
      'src/a.controller.ts': [
        "import { Controller, Post } from '@nestjs/common';",
        "import { Field } from './decorators.js';",
        "import type { TPayment } from './payment.model.js';",
        "@Controller('a')",
        'export class AController {',
        `  @Post() create(${method}): void {}`,
        '}',
        '',
      ].join('\n'),
      'golem.yaml': 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    sources:\n      - src/a.controller.ts\n    output: generated/api.json\n    openapiVersion: "3.2.0"\n    info: { title: T, version: "1" }\nmodels:\n  root: .\n',
    },
  });
  await runPipeline(path.join(root, 'golem.yaml'));
  const document = JSON.parse(fs.readFileSync(path.join(root, 'generated/api.json'), 'utf8')) as Document;
  return document.paths['/a']!.post.requestBody.content['application/json']!.schema;
}

test('the controllers job documents a body field written with a decorator re-exported under another name', async (t) => {
  // protects: T-757 the controllers job finds a parameter decorator by its resolved symbol
  const schema = await bodySchema(t, "export { Body as Field } from '@nestjs/common';\n", "@Field('payment') payment: TPayment");
  assert.deepEqual(Object.keys(schema.properties as object), ['payment']);
});
