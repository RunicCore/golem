import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runPipeline } from '#golem/cli';
import { createFixtureProject, fileFixtureScope, linkProjectPackages, onceShared } from '../fixture-project.js';
import { workspace } from '../support/process.js';
import { tscBin, writePlainTscProject } from './helpers.js';

const scope = fileFixtureScope();

const document = {
  openapi: '3.1.0',
  info: { title: 'Pay', version: '1' },
  servers: [{ url: 'https://pay.example.test' }],
  paths: {
    '/charges': {
      post: {
        operationId: 'createCharge',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Charge' } } } },
        responses: { 201: { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Charge' } } } } },
      },
    },
  },
  webhooks: {
    chargeDone: {
      post: {
        operationId: 'chargeDone',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Charge' } } } },
        responses: { 200: { description: 'ok' } },
      },
    },
  },
  components: { schemas: { Charge: { type: 'object', required: ['at'], properties: { at: { type: 'string', format: 'date-time' } } } } },
};

const main = `import { PayClient, bindPayInbound } from './sdk/index.js';
const sent: string[] = [];
const fetchImpl: typeof fetch = async (_url, init) => {
  sent.push(String(init?.body));
  return new Response('{"at":"1970-01-01T00:00:01.000Z"}', { status: 201, headers: { 'content-type': 'application/json' } });
};
const client = new PayClient({ fetchImpl });
const result = await client.createCharge().execute({ body: { at: new Date(0) } });
const received: unknown[] = [];
const handlers = bindPayInbound({
  webhookChargeDone: async (input) => {
    received.push(input.body.at instanceof Date ? input.body.at.getTime() : 'not a Date');
    return { matched: 'status', status: 200, contentType: null, body: undefined, headers: {} };
  },
});
const answered = await handlers.webhookChargeDone({ body: { at: '1970-01-01T00:00:02.000Z' } });
console.log(JSON.stringify({ sent, decoded: result.body.at instanceof Date ? result.body.at.getTime() : 'not a Date', received, status: answered.status }));
`;

/** Generates the SDK with the real pipeline into a project, then removes every @exprtlabs package so only plain tsc and node remain. */
const built = onceShared(async () => {
  const root = createFixtureProject(scope, 'golem-standalone-sdk-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"standalone-fixture","type":"module"}\n');
  fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify(document));
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nmobx: false\nvalidation: true\nopenapi:\n  - input: api.json\n    output: src/sdk\n    name: Pay\n');
  linkProjectPackages(root, Object.fromEntries(['golem', 'golem-openapi'].map((name) => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)])));
  await runPipeline(path.join(root, 'golem.yaml'));
  const generated = (): Record<string, string> => Object.fromEntries(fs.readdirSync(path.join(root, 'src/sdk'), { recursive: true, encoding: 'utf8' })
    .filter((name) => fs.statSync(path.join(root, 'src/sdk', name)).isFile()).sort().map((name) => [name, fs.readFileSync(path.join(root, 'src/sdk', name), 'utf8')]));
  const first = generated();
  const inventory = fs.readFileSync(path.join(root, '.golem/outputs.json'), 'utf8');
  await runPipeline(path.join(root, 'golem.yaml'));
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/main.ts'), main);
  writePlainTscProject(root);
  const compiled = spawnSync(process.execPath, [tscBin(), '-p', path.join(root, 'tsconfig.json')], { encoding: 'utf8' });
  return { root, first, second: generated(), inventory, compiled };
});

test('a standalone SDK compiles with plain tsc in a project with no @exprtlabs package, runs a converted call and decodes a date before an inbound port', async () => {
  // protects: T-694 R-83 a standalone SDK runs with no @exprtlabs/golem; T-712 the inbound binding runs in a standalone SDK
  const { root, compiled } = await built();
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const ran = spawnSync(process.execPath, [path.join(root, 'out/main.js')], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), '{"sent":["{\\"at\\":\\"1970-01-01T00:00:00.000Z\\"}"],"decoded":1000,"received":[2000],"status":200}');
});

test('the job records the copied runtime files and a second run writes the same bytes', async () => {
  // protects: T-694 F-34 the job owns the copy; F-133 deterministic output
  const { first, second, inventory } = await built();
  const recorded = Object.keys((JSON.parse(inventory) as { files: Record<string, unknown> }).files);
  assert.deepEqual(['runtime/runtime.impl.ts', 'runtime/runtime.ts', 'runtime/runtime.types.ts', 'runtime/types/runtime-sdk.d.ts'].filter((name) => !recorded.includes(`src/sdk/${name}`)), []);
  assert.deepEqual(second, first);
});
