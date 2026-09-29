import { copyFixture, copyFixtureFile, createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from '../fixture-project.js';
import {
  compileStrictUnusedSdk,
  generatedClientSource,
  generatedModelSource,
  isGeneratedClientClass,
  requireRecord,
} from './helpers.js';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { generate } from '#openapi/generator';
import { command, workspace } from '../packed/helpers.js';
import { tscBin } from './helpers.js';

function fixture(directory: string): string {
  copyFixture(directory, 'openapi/api/standalone');
  return path.join(directory, 'openapi.yaml');
}

test('generate returns absolute pure artifacts and local watch inputs', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-api-');
  const input = fixture(directory);
  const output = path.join(directory, 'generated');
  const result = await generate({
    input,
    output,
    name: 'StandalonePayments',
    profile: { mobx: false, validation: false },
  });

  assert.equal(result.apiVersion, 1);
  assert.deepEqual(result.manifestPaths, [path.join(output, 'model-manifest.json')]);
  assert.deepEqual(result.watchInputs, [path.join(directory, 'components.yaml'), input].sort());
  assert.equal(existsSync(output), false);
  assert.ok(result.artifacts.every(({ path: filename }) => path.isAbsolute(filename)));
  assert.equal(result.artifacts.some(({ path: filename }) => filename.endsWith('/validation.ts')), false);

  const models = generatedModelSource(result.artifacts);
  const client = generatedClientSource(result.artifacts);
  const schemas = result.artifacts.find(({ path: filename }) => filename.endsWith('/schemas.ts'))?.content;
  assert.ok(models);
  assert.ok(client);
  assert.ok(schemas);
  assert.doesNotMatch(models, /@exprtlabs\/codegen\/(mobx|mobx-validation)/);
  assert.doesNotMatch(models, /asGenObservable|validation:\s*\{/);
  assert.match(models, /registerGeneratedModel/);
  assert.doesNotMatch(client, /@exprtlabs\/codegen\/(ajv|validation)/);
  assert.doesNotMatch(schemas, /schemaRegistry|runtimeSchemaRegistry/);
});

test('OpenAPI getValidator infers generated fields and rejects handwritten subclass fields', async t => {
  const directory = createFixtureProject(t, 'runic-openapi-validator-types-');
  const input = path.join(directory, 'openapi.yaml');
  const output = path.join(directory, 'sdk');
  copyFixtureFile(directory, 'openapi/api/validator-types/openapi.yaml', 'openapi.yaml');
  const result = await generate({ input, output, name: 'ValidatorTypes', profile: { mobx: false, validation: true } });
  assert.equal(result.artifacts.some(({ path: filename }) => filename.endsWith('/validation.ts')), false);
  writeGeneratedArtifacts(result.artifacts);
  linkProjectPackages(output, { '@exprtlabs/codegen': path.join(workspace, 'packages/codegen') });
  copyFixtureFile(output, "openapi/api/consumer.ts", "consumer.ts");
  await command(directory, process.execPath, [
    tscBin(),
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--strict',
    '--skipLibCheck',
    '--outDir', path.join(output, 'build'),
    path.join(output, 'consumer.ts'),
    path.join(output, 'index.ts'),
    path.join(output, 'types.ts'),
  ]);
});

test('SDK generated with mobx and validation disabled loads and runs an operation without mobx or ajv resolvable', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-no-peer-deps-');
  const output = path.join(directory, 'sdk');
  const input = path.join(directory, 'openapi.json');
  writeFileSync(input, JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'NoPeerDeps', version: '1' },
    paths: {
      '/value': {
        get: {
          operationId: 'getValue',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
                },
              },
            },
          },
        },
      },
    },
  }));
  const result = await generate({ input, output, name: 'NoPeerDeps', profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  writeFileSync(path.join(output, 'package.json'), '{"type":"module"}\n');

  // Copy @exprtlabs/codegen's package.json and dist as real files rather than
  // symlinking (linkProjectPackages/prepareSdkProject's usual behavior): Node
  // resolves a symlink to its real path before walking node_modules, so a
  // symlinked codegen package would still resolve up into this workspace's own
  // node_modules, where mobx and ajv are installed, defeating the isolation
  // this test exists to prove. A real copy keeps the whole dependency chain
  // rooted under the temp project, where neither package exists at any
  // ancestor directory.
  const codegenSource = path.join(workspace, 'packages/codegen');
  const codegenDestination = path.join(output, 'node_modules/@exprtlabs/codegen');
  mkdirSync(codegenDestination, { recursive: true });
  cpSync(path.join(codegenSource, 'package.json'), path.join(codegenDestination, 'package.json'));
  cpSync(path.join(codegenSource, 'dist'), path.join(codegenDestination, 'dist'), { recursive: true });

  compileStrictUnusedSdk(output);

  const probes = [path.join(output, 'peer-dep-probe.mjs'), path.join(codegenDestination, 'dist/peer-dep-probe.mjs')];
  for (const probe of probes) {
    for (const missing of ['mobx', 'ajv']) {
      writeFileSync(probe, `export * from '${missing}';\n`);
      await assert.rejects(
        () => import(pathToFileURL(probe).href),
        new RegExp(`Cannot find package '${missing}'`),
      );
    }
  }

  const module = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'no-peer-deps client',
  );
  const Client = module.NoPeerDepsClient;
  if (!isGeneratedClientClass(Client)) throw new TypeError('NoPeerDepsClient');
  const client = new Client({
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const response = await client.getValue().execute({});
  assert.deepEqual(response.body, { ok: true });
});

test('profile is mandatory and source validation remains enabled for all profiles', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-invalid-');
  const input = path.join(directory, 'invalid.yaml');
  writeFileSync(input, 'openapi: 2.0\ninfo: {}\npaths: {}\n');
  await assert.rejects(
    () => Reflect.apply(generate, undefined, [{ input, output: path.join(directory, 'out') }]),
    /profile is required/,
  );
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'out'), profile: { mobx: false, validation: false } }),
    /unsupported OpenAPI version/,
  );
});
