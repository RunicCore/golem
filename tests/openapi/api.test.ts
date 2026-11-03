import { copyFixture, createFixtureProject, writeGeneratedArtifacts } from '../fixture-project.js';
import {
  compileStrictUnusedSdk,
  generatedClientSource,
  isGeneratedClientClass,
  requireRecord,
} from './helpers.js';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import test from 'node:test';
import { generate } from '#openapi/generator';
import { workspace } from '../support/process.js';

function fixture(directory: string): string {
  copyFixture(directory, 'openapi/api/standalone');
  return path.join(directory, 'openapi.yaml');
}

test('generate returns absolute pure artifacts and local watch inputs', async (t) => {
  const directory = createFixtureProject(t, 'golem-openapi-api-');
  const input = fixture(directory);
  const output = path.join(directory, 'generated');
  const result = await generate({
    input,
    output,
    name: 'StandalonePayments',
    profile: { validation: false },
  });

  assert.equal(result.apiVersion, 1);
  assert.deepEqual(result.manifestPaths, [path.join(output, 'model-manifest.json')]);
  assert.deepEqual(result.watchInputs, [path.join(directory, 'components.yaml'), input].sort());
  assert.equal(existsSync(output), false);
  assert.ok(result.artifacts.every(({ path: filename }) => path.isAbsolute(filename)));

  const client = generatedClientSource(result.artifacts);
  assert.ok(client);
});

test('SDK generated with mobx and validation disabled loads and runs an operation without mobx resolvable', async (t) => {
  const directory = createFixtureProject(t, 'golem-openapi-no-peer-deps-');
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
  const result = await generate({ input, output, name: 'NoPeerDeps', profile: { validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  writeFileSync(path.join(output, 'package.json'), '{"type":"module"}\n');

  // Copy @exprtlabs/golem's package.json and dist as real files rather than
  // symlinking (linkProjectPackages/prepareSdkProject's usual behavior): Node
  // resolves a symlink to its real path before walking node_modules, so a
  // symlinked golem package would still resolve up into this workspace's own
  // node_modules, where mobx is installed, defeating the isolation
  // this test exists to prove. A real copy keeps the whole dependency chain
  // rooted under the temp project, where mobx does not exist at any
  // ancestor directory.
  const golemSource = path.join(workspace, 'packages/golem');
  const golemDestination = path.join(output, 'node_modules/@exprtlabs/golem');
  mkdirSync(golemDestination, { recursive: true });
  cpSync(path.join(golemSource, 'package.json'), path.join(golemDestination, 'package.json'));
  cpSync(path.join(golemSource, 'dist'), path.join(golemDestination, 'dist'), { recursive: true });

  compileStrictUnusedSdk(output);

  const probeDirectories = [output, path.join(golemDestination, 'dist')];
  for (const directory of probeDirectories) {
    const probe = path.join(directory, 'peer-dep-probe-mobx.mjs');
    writeFileSync(probe, "export * from 'mobx';\n");
    await assert.rejects(
      () => import(pathToFileURL(probe).href),
      /Cannot find package 'mobx'/,
    );
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

test('an input document that is not YAML fails with its path relative to the working directory, the line and the column', async (t) => {
  // protects: T-311 a YAML parse error names the file
  const directory = createFixtureProject(t, 'golem-openapi-broken-');
  const input = path.join(directory, 'broken.yaml');
  writeFileSync(input, 'openapi: 3.1.0\ninfo:\n  title: a: b\npaths: {}\n');
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'out'), profile: { validation: false } }),
    (error: unknown) => error instanceof Error && error.message.startsWith(`${path.relative(process.cwd(), input)}:3:10 `) && error.cause instanceof YAML.YAMLParseError,
  );
});

test('profile is mandatory and source validation remains enabled for all profiles', async (t) => {
  const directory = createFixtureProject(t, 'golem-openapi-invalid-');
  const input = path.join(directory, 'invalid.yaml');
  writeFileSync(input, 'openapi: 2.0\ninfo: {}\npaths: {}\n');
  await assert.rejects(
    () => Reflect.apply(generate, undefined, [{ input, output: path.join(directory, 'out') }]),
    /profile is required/,
  );
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'out'), profile: { validation: false } }),
    /unsupported OpenAPI version/,
  );
});
