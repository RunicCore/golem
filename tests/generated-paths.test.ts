import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODEL_OUTPUT, defaultModelOutput } from '#golem/generated-paths';
import { workspace } from './support/process.js';

test('default generated paths resolve under the job root', () => {
  assert.equal(defaultModelOutput('/project'), path.join('/project', 'src/generated/models'));
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

test('the default model output is src/generated/models', () => {
  assert.equal(DEFAULT_MODEL_OUTPUT, 'src/generated/models');
});
