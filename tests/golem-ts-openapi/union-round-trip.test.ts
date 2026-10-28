import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { LibError } from '@exprtlabs/golem/errors';
import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, importGeneratedModule, isGeneratedModelClass, type GeneratedModelClass } from '../openapi/helpers.js';

const controllerOf = (models: string, model: string): string => `import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';

${models}

@Controller('items')
export class ItemsController {
  @Post()
  create(@Body() body: ${model}): ${model} { return body; }
}
`;

type Version = '3.2.0' | '3.1.2';

async function controllersDocument(t: TestContext, source: string, openapiVersion: Version): Promise<{ readonly components: { readonly schemas: Record<string, Record<string, unknown>> } }> {
  const root = createControllerFixture(t, { prefix: 'golem-ts-openapi-union-round-trip-', sourceFile: 'src/items.controller.ts', source });
  const result = await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion, info: { title: 'Items', version: '1' }, profile: { mobx: false, validation: false } });
  return JSON.parse(result.artifacts[0]!.content) as { components: { schemas: Record<string, Record<string, unknown>> } };
}

async function sdkModels(t: TestContext, document: unknown): Promise<Record<string, GeneratedModelClass>> {
  const output = path.join(createFixtureProject(t, 'golem-union-round-trip-sdk-'), 'sdk');
  await generateMaterializedSdk(document, { output, name: 'Items', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  const exports = await importGeneratedModule(output, 'items models');
  return Object.fromEntries(Object.entries(exports).filter((entry): entry is [string, GeneratedModelClass] => isGeneratedModelClass(entry[1])));
}

const CONTACT = `export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
export type TContact = IModel<{ value: (TEmail | TPhone) & Discriminator<'kind'> }>;`;

for (const openapiVersion of ['3.2.0', '3.1.2'] as const) {
  test(`a model union documents its declared tag key and values, and the SDK generated from the document decodes by them on ${openapiVersion}`, async t => {
    // protects: T-599 the document writes the declared key (not a detected one) with a mapping from each value to its component, and the SDK reads it back
    const document = await controllersDocument(t, controllerOf(CONTACT, 'TContact'), openapiVersion);
    assert.deepEqual((document.components.schemas.TContact!.properties as Record<string, unknown>).value, {
      discriminator: { propertyName: 'kind', mapping: { email: '#/components/schemas/TEmail', phone: '#/components/schemas/TPhone' } },
      oneOf: [{ $ref: '#/components/schemas/TEmail' }, { $ref: '#/components/schemas/TPhone' }],
    });

    const models = await sdkModels(t, { ...document, openapi: openapiVersion });
    const email = { value: { kind: 'email', address: 'a@b.c' } };
    const phone = { value: { kind: 'phone', number: '555' } };
    const decodedEmail = decodeGeneratedModel(models.TContactModel!, email) as { value: object };
    const decodedPhone = decodeGeneratedModel(models.TContactModel!, phone) as { value: object };
    assert.ok(decodedEmail.value instanceof models.TEmailModel!);
    assert.ok(decodedPhone.value instanceof models.TPhoneModel!);
    assert.deepEqual(encodeGeneratedModel(decodedEmail), email);
    assert.deepEqual(encodeGeneratedModel(decodedPhone), phone);
    assert.throws(() => decodeGeneratedModel(models.TContactModel!, { value: { kind: 'fax', number: '555' } }), LibError);
  });
}

const PAYMENT = `export type TCard = IModel<{ kind: 'card'; number: string }>;
export type TCash = IModel<{ kind: 'cash'; amount: number }>;
export type TOther = IModel<{ note: string }>;
export type TPayment = IModel<{ method: (TCard | TCash | TOther) & Discriminator<'kind', TOther> }>;`;

test('a declared default variant is the defaultMapping of the 3.2 document', async t => {
  // protects: T-599 OpenAPI 3.2 defaultMapping states the declared default
  const document = await controllersDocument(t, controllerOf(PAYMENT, 'TPayment'), '3.2.0');
  const method = (document.components.schemas.TPayment!.properties as Record<string, { oneOf: { $ref: string }[] }>).method!;
  assert.deepEqual((method as Record<string, unknown>).discriminator, {
    propertyName: 'kind',
    mapping: { card: '#/components/schemas/TCard', cash: '#/components/schemas/TCash' },
    defaultMapping: '#/components/schemas/TOther',
  });
  assert.deepEqual(method.oneOf.map(branch => branch.$ref).sort(), ['#/components/schemas/TCard', '#/components/schemas/TCash', '#/components/schemas/TOther']);
});

test('OpenAPI 3.1 has no defaultMapping, so a union with a declared default is anyOf with no discriminator', async t => {
  // protects: T-599 3.1 cannot state the default, and a discriminator over a variant without the tag would break its rule
  const document = await controllersDocument(t, controllerOf(PAYMENT, 'TPayment'), '3.1.2');
  const method = (document.components.schemas.TPayment!.properties as Record<string, Record<string, unknown>>).method!;
  assert.equal(method.discriminator, undefined);
  assert.equal(method.oneOf, undefined);
  assert.equal((method.anyOf as unknown[]).length, 3);
});
