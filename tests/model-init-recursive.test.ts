import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { repoRoot, tscBin } from './openapi/helpers.js';

const source = String.raw`import type { ModelInit } from '@exprtlabs/golem/model';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Tree = [string, Tree[]];

export const json: ModelInit<{ payload: JsonValue }> = { payload: { list: [1, { deep: ['x', null] }] } };
export const tree: ModelInit<{ tree: Tree }> = { tree: ['root', [['leaf', []]]] };
// @ts-expect-error a leaf that is not a JSON value
export const leaf: ModelInit<{ payload: JsonValue }> = { payload: { list: [Symbol('x')] } };

// A tuple keeps its length, its readonly modifier and its optional and rest elements.
export const optional: ModelInit<{ pair: readonly [string, Date?] }> = { pair: ['a'] };
export const rest: ModelInit<{ rest: [string, ...number[]] }> = { rest: ['a', 1, 2] };
// @ts-expect-error a tuple of two elements needs both
export const short: ModelInit<{ pair: [string, number] }> = { pair: ['a'] };
// @ts-expect-error a readonly array does not accept a push
export const readonlyList: ModelInit<{ list: readonly string[] }> = { list: ['a'] }; readonlyList.list.push('b');
`;

test('ModelInit ends on a recursive array or tuple type and keeps the shape of a tuple', t => {
  // protects: T-251 ModelInit<JsonValue> compiles without TS2589
  const root = createFixtureProject(t, 'golem-model-init-');
  linkProjectPackages(root, { '@exprtlabs/golem': path.join(repoRoot(), 'packages/golem') });
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(root, 'init.ts'), source);
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: [] },
    files: ['init.ts'],
  }));
  const compiled = spawnSync(process.execPath, [tscBin(), '-p', path.join(root, 'tsconfig.json')], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});
