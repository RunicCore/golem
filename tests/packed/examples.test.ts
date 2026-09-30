import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { command } from '../support/process.js';
import { copyExample, assertExecutedConsumerTests } from '../support/consumer.js';
import { startRegistry, type PackedRegistry } from '../../scripts/packed-registry.js';
import { SOURCE_EXAMPLES } from '../../scripts/maintained-examples.js';
import type { SourceExampleName } from '../../scripts/maintained-examples.js';

let registry: PackedRegistry;

async function runConsumerShell(cwd: string, source: string, registryRoot: string): Promise<Awaited<ReturnType<typeof command>>> {
  return runConsumerShellWithEnvironment(cwd, source, registryRoot);
}

async function runConsumerShellWithEnvironment(
  cwd: string,
  source: string,
  registryRoot: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<Awaited<ReturnType<typeof command>>> {
  return command(cwd, '/bin/sh', ['-eu', '-c', source], {
    timeout: 300000,
    env: {
      ...environment,
      NPM_CONFIG_USERCONFIG: path.join(registryRoot, '.npmrc'),
      npm_config_userconfig: path.join(registryRoot, '.npmrc'),
    },
  });
}

interface ExampleHttpFixture {
  readonly baseUrl: string;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

async function startExampleHttpFixture(): Promise<ExampleHttpFixture> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const method = request.method ?? '';
    const url = request.url ?? '/';
    requests.push(`${method} ${url}`);
    if (method === 'GET' && url === '/tasks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([
        { id: 'task-1', title: 'Write release notes' },
        { id: 'task-2', title: 'Update the help page' },
      ]));
      return;
    }
    if (method === 'POST' && url === '/payments') {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
      request.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      request.on('error', () => {
        if (!response.writableEnded) {
          response.writeHead(400);
          response.end();
        }
      });
      return;
    }
    if (method === 'PUT' && url === '/projects/project-ops/access') {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
      request.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      request.on('error', () => {
        if (!response.writableEnded) {
          response.writeHead(400);
          response.end();
        }
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error('Example HTTP fixture did not bind TCP');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function freshConsumerParent(t: TestContext, label: string): string {
  const root = registry.create(t, `source-example-${label}`);
  fs.rmSync(path.join(root, 'package.json'), { force: true });
  return root;
}

function packageManifest(root: string, name: string): Record<string, unknown> {
  const filename = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
  assert.ok(fs.existsSync(filename), `${name} must be installed from the source example command`);
  const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(typeof value, 'object');
  assert.ok(value !== null);
  return value as Record<string, unknown>;
}

function assertInstalledRelease(root: string, names: readonly string[]): void {
  for (const name of names) {
    assert.equal(packageManifest(root, name).version, registry.workspaceVersion, `${name} must resolve the RC release`);
  }
}

function assertPackagePlacement(root: string, production: readonly string[], development: readonly string[]): void {
  const manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of production) {
    assert.equal(typeof manifest.dependencies?.[name], 'string', `${name} must be a production dependency`);
    assert.equal(manifest.devDependencies?.[name], undefined, `${name} must not be a development dependency`);
  }
  for (const name of development) {
    assert.equal(typeof manifest.devDependencies?.[name], 'string', `${name} must be a development dependency`);
    assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be a production dependency`);
  }
}

function assertAbsent(root: string, names: readonly string[]): void {
  for (const name of names) assert.equal(fs.existsSync(path.join(root, 'node_modules', ...name.split('/'))), false, `${name} must not leak into this standalone source consumer`);
}

function assertPackedRcRegistry(): void {
  assert.equal(registry.npmVersion, '10.9.8', 'packed source consumer checks must use the packed npm baseline');
  assert.ok(registry.workspaceVersion.includes('-'), 'the packed fixture must be a prerelease');
  assert.deepEqual(registry.distTags, { rc: registry.workspaceVersion }, 'the fixture registry must expose the candidate only under rc');
}

interface SourceExampleProfile {
  readonly name: SourceExampleName;
  readonly config: RegExp;
  readonly install: readonly string[];
  readonly production: readonly string[];
  readonly development: readonly string[];
  readonly prePruneAbsent: readonly string[];
  readonly postPruneAbsent: readonly string[];
  readonly http?: 'tasks' | 'payments' | 'showcase';
  readonly output?: RegExp;
  /** Server examples compile and test their app but are not started by this source check. */
  readonly execute?: boolean;
}

const sourceExampleProfiles: readonly SourceExampleProfile[] = [
  {
    name: 'model',
    config: /models:\s*\n\s+root:/,
    install: [
      'npm install @exprtlabs/codegen@rc ajv@8.20.0 ajv-formats@3.0.1',
      'npm install --save-dev @exprtlabs/model-codegen@rc typescript@~7.0.2 ttsc@~0.30.4 @types/node@22.20.1',
    ],
    production: ['@exprtlabs/codegen', 'ajv', 'ajv-formats'],
    development: ['@exprtlabs/model-codegen', 'typescript', 'ttsc', '@types/node'],
    prePruneAbsent: ['mobx', '@exprtlabs/openapi-to-ts'],
    postPruneAbsent: ['esbuild', 'mobx', '@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    output: /model: saved task/,
  },
  {
    name: 'openapi',
    config: /^(?=[\s\S]*validation:\s*true)(?=[\s\S]*mobx:\s*false)[\s\S]*openapi:/m,
    install: [
      'npm install @exprtlabs/codegen@rc ajv@8.20.0 ajv-formats@3.0.1',
      'npm install --save-dev @exprtlabs/openapi-to-ts@rc typescript@~7.0.2 ttsc@~0.30.4 @types/node@22.20.1',
    ],
    production: ['@exprtlabs/codegen', 'ajv', 'ajv-formats'],
    development: ['@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    prePruneAbsent: ['mobx', '@exprtlabs/model-codegen'],
    postPruneAbsent: ['esbuild', 'mobx', '@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    http: 'tasks',
    output: /openapi: received tasks/,
  },
  {
    name: 'combined',
    config: /^(?=[\s\S]*validation:\s*true)(?=[\s\S]*mobx:\s*false)[\s\S]*openapi:/m,
    install: [
      'npm install @exprtlabs/codegen@rc ajv@8.20.0 ajv-formats@3.0.1',
      'npm install --save-dev @exprtlabs/model-codegen@rc @exprtlabs/openapi-to-ts@rc typescript@~7.0.2 ttsc@~0.30.4 @types/node@22.20.1',
    ],
    production: ['@exprtlabs/codegen', 'ajv', 'ajv-formats'],
    development: ['@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    prePruneAbsent: ['mobx'],
    postPruneAbsent: ['esbuild', 'mobx', '@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    http: 'payments',
    output: /combined: payment saved/,
  },
  {
    name: 'model-mobx',
    config: /^(?=[\s\S]*validation:\s*false)(?=[\s\S]*mobx:\s*true)[\s\S]*models:/m,
    install: [
      'npm install @exprtlabs/codegen@rc mobx@6.16.1',
      'npm install --save-dev @exprtlabs/model-codegen@rc typescript@~7.0.2 ttsc@~0.30.4 @types/node@22.20.1',
    ],
    production: ['@exprtlabs/codegen', 'mobx'],
    development: ['@exprtlabs/model-codegen', 'typescript', 'ttsc', '@types/node'],
    prePruneAbsent: ['@exprtlabs/openapi-to-ts'],
    postPruneAbsent: ['ajv', 'ajv-formats', 'esbuild', '@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    output: /model-mobx: saved task/,
  },
  {
    name: 'combined-mobx',
    config: /^(?=[\s\S]*validation:\s*true)(?=[\s\S]*mobx:\s*true)[\s\S]*openapi:/m,
    install: [
      'npm install @exprtlabs/codegen@rc ajv@8.20.0 ajv-formats@3.0.1 mobx@6.16.1',
      'npm install --save-dev @exprtlabs/model-codegen@rc @exprtlabs/openapi-to-ts@rc typescript@~7.0.2 ttsc@~0.30.4 @types/node@22.20.1',
    ],
    production: ['@exprtlabs/codegen', 'ajv', 'ajv-formats', 'mobx'],
    development: ['@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    prePruneAbsent: [],
    postPruneAbsent: ['esbuild', '@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    http: 'payments',
    output: /combined-mobx: payment saved/,
  },
  {
    name: 'showcase',
    config: /^(?=[\s\S]*validation:\s*true)(?=[\s\S]*mobx:\s*false)[\s\S]*openapi:/m,
    install: [
      'npm install @exprtlabs/codegen@rc ajv@8.20.0 ajv-formats@3.0.1',
      'npm install --save-dev @exprtlabs/model-codegen@rc @exprtlabs/openapi-to-ts@rc typescript@~7.0.2 ttsc@~0.30.4 @types/node@22.20.1',
    ],
    production: ['@exprtlabs/codegen', 'ajv', 'ajv-formats'],
    development: ['@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    prePruneAbsent: ['mobx'],
    postPruneAbsent: ['esbuild', 'mobx', '@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', 'typescript', 'ttsc', '@types/node'],
    http: 'showcase',
    output: /showcase: (?:wire|permission error|HTTP response)/,
  },
  {
    name: 'nest-openapi',
    config: /controllers:\s*\n[\s\S]*openapi:\s*\n[\s\S]*models:\s*\n/m,
    install: [
      'npm install @exprtlabs/codegen@rc @nestjs/common@11.2.3 @nestjs/core@11.2.3 @nestjs/platform-express@11.2.3 @nestjs/swagger@11.4.7 reflect-metadata@0.2.2 rxjs@7.8.2 ajv@8.20.0 ajv-formats@3.0.1',
      'npm install --save-dev @exprtlabs/model-codegen@rc @exprtlabs/openapi-to-ts@rc @exprtlabs/ts-to-openapi@rc typescript@~7.0.2 ttsc@~0.30.4 @types/node@22.20.1',
    ],
    production: [
      '@exprtlabs/codegen', '@nestjs/common', '@nestjs/core', '@nestjs/platform-express',
      '@nestjs/swagger', 'reflect-metadata', 'rxjs', 'ajv', 'ajv-formats',
    ],
    development: ['@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', '@exprtlabs/ts-to-openapi', 'typescript', 'ttsc', '@types/node'],
    prePruneAbsent: ['mobx'],
    postPruneAbsent: ['esbuild', '@redocly/openapi-core', 'mobx', '@exprtlabs/model-codegen', '@exprtlabs/openapi-to-ts', '@exprtlabs/ts-to-openapi', 'typescript', 'ttsc', '@types/node'],
    execute: false,
  },
];

function copiedSourceRoot(t: TestContext, label: string): { readonly parent: string; readonly root: string } {
  const parent = freshConsumerParent(t, `source-${label}`);
  const root = path.join(parent, 'app');
  fs.mkdirSync(root, { recursive: true });
  return { parent, root };
}

before(async () => {
  registry = await startRegistry();
  assertPackedRcRegistry();
});

after(async () => {
  if (registry) await registry.close();
});

test('maintained source examples are standalone RC consumers for every supported profile', async t => {
  assert.deepEqual(sourceExampleProfiles.map(profile => profile.name), [...SOURCE_EXAMPLES],
    'the packed source consumer test must cover every maintained source example');

  for (const profile of sourceExampleProfiles) {
    await t.test(profile.name, async context => {
      const { parent, root } = copiedSourceRoot(context, profile.name);
      copyExample(root, profile.name);
      fs.copyFileSync(path.join(parent, '.npmrc'), path.join(root, '.npmrc'));
      assert.ok(fs.existsSync(path.join(root, 'package.json')), `${profile.name} source must include package.json`);
      assert.ok(fs.existsSync(path.join(root, 'runic-codegen.yaml')), `${profile.name} source must include runic-codegen.yaml`);
      assert.ok(fs.existsSync(path.join(root, 'tsconfig.json')), `${profile.name} source must include tsconfig.json`);
      assert.ok(fs.existsSync(path.join(root, 'src/main.ts')), `${profile.name} source must include src/main.ts`);
      assert.match(fs.readFileSync(path.join(root, 'runic-codegen.yaml'), 'utf8'), profile.config, `${profile.name} source must retain its generator profile`);

      await runConsumerShell(root, profile.install.join('\n'), parent);
      assertPackagePlacement(root, profile.production, profile.development);
      assertInstalledRelease(root, profile.production.filter(name => name.startsWith('@exprtlabs/')));
      assertInstalledRelease(root, profile.development.filter(name => name.startsWith('@exprtlabs/')));
      assertAbsent(root, profile.prePruneAbsent);

      // Check before any regeneration: the committed generated files must match
      // the packed generators exactly, not merely be reproducible.
      await runConsumerShell(root, 'npm run check', parent);
      const testResult = await runConsumerShell(root, 'npm test', parent);
      assertExecutedConsumerTests(testResult.stdout, `${profile.name} maintained example npm test`);

      await runConsumerShell(root, 'npm prune --omit=dev --omit=optional', parent);
      assertInstalledRelease(root, profile.production.filter(name => name.startsWith('@exprtlabs/')));
      assertAbsent(root, profile.postPruneAbsent);

      if (profile.execute === false) {
        const result = await runConsumerShell(root, 'node --test --test-reporter=tap .build/src/app.test.js', parent);
        assertExecutedConsumerTests(result.stdout, 'the maintained Nest example after production pruning');
        return;
      }

      const fixture = profile.http ? await startExampleHttpFixture() : undefined;
      try {
        const result = fixture
          ? await runConsumerShellWithEnvironment(root, 'node .build/src/main.js', parent, {
            API_BASE_URL: fixture.baseUrl,
            TASKS_API_BASE_URL: fixture.baseUrl,
            PAYMENTS_API_BASE_URL: fixture.baseUrl,
            PROJECT_ACCESS_API_BASE_URL: fixture.baseUrl,
          })
          : await runConsumerShell(root, 'node .build/src/main.js', parent);
        if (profile.output) {
          assert.match(`${result.stdout}\n${result.stderr}`, profile.output, `${profile.name} source must execute its application path`);
        }
        if (profile.http === 'tasks') assert.deepEqual(fixture?.requests, ['GET /tasks'], `${profile.name} must make a real HTTP request`);
        if (profile.http === 'payments') assert.deepEqual(fixture?.requests, ['POST /payments'], `${profile.name} must make a real HTTP request`);
        if (profile.http === 'showcase') assert.deepEqual(fixture?.requests, ['PUT /projects/project-ops/access'], `${profile.name} must make a real HTTP request`);
      } finally {
        if (fixture) await fixture.close();
      }
    });
  }
});
