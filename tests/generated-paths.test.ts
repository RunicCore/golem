import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_MODEL_OUTPUT, OPERATION_CODEC_REGISTRY, defaultModelOutput, isOperationCodecRegistry, operationCodecRegistryPath,
} from '#golem/generated-paths';
import { workspace } from './support/process.js';

test('default generated paths resolve under the job root', () => {
  assert.equal(defaultModelOutput('/project'), path.join('/project', 'src/generated/models'));
  assert.equal(operationCodecRegistryPath('/project'), path.join('/project', 'src/generated/operation-codecs.ts'));
  assert.equal(isOperationCodecRegistry('src/generated/operation-codecs.ts'), true);
  assert.equal(isOperationCodecRegistry('app/src/generated/operation-codecs.ts'), true);
  assert.equal(isOperationCodecRegistry('src/generated/operation-codecs.ts.bak'), false);
  assert.equal(isOperationCodecRegistry('xsrc/generated/operation-codecs.ts'), false);
});

// Budget (Spec A D4): default paths have one owner. Only generated-paths.ts may spell them.
test('no package source outside generated-paths.ts spells a default generated path', () => {
  const offenders: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!file.endsWith('.ts') || file.endsWith('generated-paths.ts')) continue;
      if (fs.readFileSync(file, 'utf8').includes('src/generated')) offenders.push(path.relative(workspace, file));
    }
  };
  for (const name of fs.readdirSync(path.join(workspace, 'packages'))) {
    const source = path.join(workspace, 'packages', name, 'src');
    if (fs.existsSync(source)) visit(source);
  }
  assert.deepEqual(offenders, []);
});

test('the Go plugin default registry path equals the TypeScript default', () => {
  const go = fs.readFileSync(path.join(workspace, 'packages/golem/plugin/nest.go'), 'utf8');
  const match = /const defaultOperationCodecRegistry = "([^"]+)"/.exec(go);
  assert.ok(match, 'nest.go declares defaultOperationCodecRegistry');
  assert.equal(match[1], OPERATION_CODEC_REGISTRY);
  assert.equal(DEFAULT_MODEL_OUTPUT, 'src/generated/models');
});
