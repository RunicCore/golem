import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import { generateMaterializedSdk } from './helpers.js';

const document = {
  openapi: '3.1.0', info: { title: 'Keys', version: '1' }, paths: {},
  components: { schemas: {
    Money: { type: 'object', properties: { amount: { type: 'string' } }, required: ['amount'] },
    Payment: { type: 'object', properties: { money: { $ref: '#/components/schemas/Money' } }, required: ['money'] },
  } },
};

test('each model appears once in the plugin keys, under the file that declares its class', async t => {
  const output = path.join(createFixtureProject(t, 'runic-plugin-keys-'), 'sdk');
  const result = await generateMaterializedSdk(document, { output, name: 'Keys', profile: { mobx: false, validation: true } });
  const keys = result.artifacts.find(a => a.path.endsWith('/iobject-plugin-keys.ts'))!.content;
  const entries = [...keys.matchAll(/^\s+"([^"]+)#(\w+)": "([^"]+)",$/gm)].map(([, source, name, id]) => ({ source, name, id }));
  assert.deepEqual(entries.map(e => e.name).sort(), ['MoneyModel', 'PaymentModel']);
  for (const entry of entries) {
    const declaring = result.artifacts.find(a => a.path.endsWith(`/${entry.source}`));
    assert.ok(declaring, `${entry.source} is generated`);
    assert.match(declaring.content, new RegExp(`export class ${entry.name}\\b`), `${entry.source} declares ${entry.name}`);
  }
});
