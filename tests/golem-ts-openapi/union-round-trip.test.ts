import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibError } from '@exprtlabs/golem/errors';
import { generate } from '#controllers/generator';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';
import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, sdkBodyCodec, withRootOperations, type SdkBodyCodec } from '../openapi/helpers.js';

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
  const result = await generate({ root, output: path.join(root, 'openapi.json'), openapiVersion, info: { title: 'Items', version: '1' }, profile: { validation: false } });
  return JSON.parse(result.artifacts[0]!.content) as { components: { schemas: Record<string, Record<string, unknown>> } };
}

/** The client body codec of the SDK generated from `document` for the component `root`. */
async function sdkRoot(t: TestContext, document: Record<string, unknown>, root: string): Promise<SdkBodyCodec> {
  const output = path.join(createFixtureProject(t, 'golem-union-round-trip-sdk-'), 'sdk');
  await generateMaterializedSdk(withRootOperations(document, root), { output, name: 'Items', profile: { validation: true } });
  compileGeneratedSdk(output, [], { strict: true });
  return sdkBodyCodec(output, 'Items', root);
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

    const contact = await sdkRoot(t, { ...document, openapi: openapiVersion }, 'TContact');
    const email = { value: { kind: 'email', address: 'a@b.c' } };
    const phone = { value: { kind: 'phone', number: '555' } };
    assert.deepEqual(await contact.decode(email), email);
    assert.deepEqual(await contact.decode(phone), phone);
    assert.deepEqual(await contact.encode(email), email);
    assert.deepEqual(await contact.encode(phone), phone);
    await assert.rejects(() => contact.decode({ value: { kind: 'fax', number: '555' } }), LibError);
    // The tag selects the variant: an email tag with a phone's fields is no email.
    await assert.rejects(() => contact.decode({ value: { kind: 'email', number: '555' } }), LibError);
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

test('the SDK generated from the 3.2 document decodes a value with an unmapped tag to the declared default and encodes it back', async t => {
  // protects: T-604 the declared default round-trips on 3.2 (golem-openapi-ts reads defaultMapping)
  const document = await controllersDocument(t, controllerOf(PAYMENT, 'TPayment'), '3.2.0');
  const payment = await sdkRoot(t, document, 'TPayment');
  const card = { method: { kind: 'card', number: '1234' } };
  const cash = { method: { kind: 'cash', amount: 5 } };
  const note = { method: { note: 'wire' } };
  assert.deepEqual(await payment.decode(card), card);
  assert.deepEqual(await payment.decode(cash), cash);
  assert.deepEqual(await payment.decode(note), note);
  assert.deepEqual(await payment.encode(card), card);
  assert.deepEqual(await payment.encode(cash), cash);
  assert.deepEqual(await payment.encode(note), note);
  // An unmapped tag takes the declared default variant, so decoding it without the check reads it; a mapped tag never falls back to it.
  const unmapped = { method: { kind: 'wire', note: 'x' } };
  assert.deepEqual(await payment.decode(unmapped, { validate: false }), unmapped);
  await assert.rejects(() => payment.decode({ method: { kind: 'cash', note: 'x' } }), LibError);
});

test('OpenAPI 3.1 has no defaultMapping, so a union with a declared default is anyOf with no discriminator', async t => {
  // protects: T-599 3.1 cannot state the default, and a discriminator over a variant without the tag would break its rule
  const document = await controllersDocument(t, controllerOf(PAYMENT, 'TPayment'), '3.1.2');
  const method = (document.components.schemas.TPayment!.properties as Record<string, Record<string, unknown>>).method!;
  assert.equal(method.discriminator, undefined);
  assert.equal(method.oneOf, undefined);
  assert.equal((method.anyOf as unknown[]).length, 3);
});
