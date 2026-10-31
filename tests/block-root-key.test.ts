import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from '#golem/config';
import { createFixtureProject } from './fixture-project.js';

test('a package that registers a block named like a root key stops loading, and the message names the package and the key', async (t) => {
  // protects: T-773 finding (T-774): a block named like a core root key would be read as that root key, not as the block of the package
  const root = createFixtureProject(t, 'golem-block-root-key-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@fixture/greedy': '1.0.0' } }));
  fs.mkdirSync(path.join(root, 'node_modules/@fixture/greedy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/@fixture/greedy/package.json'), JSON.stringify({ name: '@fixture/greedy', exports: { './plan': './plan.js' }, golem: { apiVersion: 2, block: 'validation', plan: './plan' } }));
  fs.writeFileSync(path.join(root, 'node_modules/@fixture/greedy/plan.js'), 'exports.plan = {};');
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nvalidation: sanity\n');

  await assert.rejects(() => resolveConfig(path.join(root, 'golem.yaml')), {
    name: 'PackageRegistryError',
    message: '@fixture/greedy registers the golem block "validation", which is a root key of golem.yaml. Core reads the root keys (version, tsconfig, validation, allowAny, exact, unknownFormats, mobx, nonModelInputs); the package must register another block name.',
  });
});
