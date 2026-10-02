import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as ts from '@exprtlabs/golem/ts';
import { generate } from '#model/generator';
import { resolveTypeScript } from '#golem/typescript-version';
import { createFixtureProject, readFixture } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tsSource } from './source-template.js';

// The cases marked `skip` run only on the TypeScript 6 lane: GOLEM_TYPESCRIPT_ROOT names a project whose `typescript` is 6.x.
const skip = resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? process.cwd()).major !== 6
  && 'the active TypeScript is not 6.x';

test('the facade runs on TypeScript 6', { skip }, () => {
  assert.match(ts.typescriptVersion, /^6\./);
});

test('a class whose type parameter has a default generates without RUNM1063', { skip }, t => {
  // `Uint8Array<TArrayBuffer = ArrayBufferLike>` has a defaulted type parameter; TypeScript 6 names that default `default`.
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-ts6-default-', name: 'ts6-default' });
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), `export type Base64 = string;
export function encodeBytes(value: Uint8Array): Base64 { return btoa(String.fromCharCode(...value)); }
export function decodeBytes(value: Base64): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
`);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';
import { encodeBytes, decodeBytes } from './codecs.js';
type Bytes = Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;`,
    fields: tsSource`bytes: Bytes`,
  }).text);
  const result = generate({ root, profile: { mobx: false, validation: true } });
  const generated = result.artifacts.find(artifact => artifact.path.endsWith('a.model.generated.ts'))?.content ?? '';
  assert.match(generated, /\bUint8Array\b/);
  assert.doesNotMatch(generated, /Uint8Array</);
});

test('a program session reuses the SourceFile of an unchanged input and parses a changed one again', { skip }, t => {
  const root = createFixtureProject(t, 'golem-ts6-session-');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, noEmit: true }, include: [] }));
  const changed = path.join(root, 'changed.ts');
  const unchanged = path.join(root, 'unchanged.ts');
  fs.writeFileSync(unchanged, 'export const unchanged = 1;\n');
  const overlays = (text: string): ReadonlyMap<string, string> => new Map([[changed, text]]);
  using session = new ts.ProgramSession({ cwd: root });
  const first = session.openProgram({ root, sources: [changed, unchanged], overlays: overlays('export const value = 1;\n') });
  const before = { changed: first.getSourceFile(changed), unchanged: first.getSourceFile(unchanged), lib: first.getSourceFiles().find(file => first.isSourceFileDefaultLibrary(file)) };
  assert.ok(before.changed && before.unchanged && before.lib, 'the first program must hold both inputs and a default library file');

  session.inputsChanged([changed]);
  using second = session.openProgram({ root, sources: [changed, unchanged], overlays: overlays('export const value = 2;\n') });
  assert.equal(second.getSourceFile(unchanged), before.unchanged, 'an unchanged input keeps its SourceFile');
  assert.equal(second.getSourceFile(before.lib.fileName), before.lib, 'a library file keeps its SourceFile');
  const after = second.getSourceFile(changed);
  assert.ok(after && after !== before.changed, 'a changed input is parsed again');
  assert.match(after.text, /value = 2/);
  first.close();
});

test('union members come out in one order whichever order the checker created their types in', t => {
  // Each model is generated alone, so its literal types are created in its own declaration order.
  // The checker orders a union by type creation, so only the analysis's own sort can make the two outputs agree.
  const fieldLines = (name: 'a' | 'b'): string[] => {
    const { root, sourceRoot } = createModelProject(t, { prefix: `golem-ts6-union-${name}-`, name: `ts6-union-${name}` });
    fs.writeFileSync(path.join(sourceRoot, `${name}.model.ts`), readFixture(`models/union-order/${name}.model.ts`));
    const artifact = generate({ root, profile: { mobx: false, validation: true } }).artifacts
      .find(candidate => candidate.path.endsWith(`${name}.model.generated.ts`));
    assert.ok(artifact, `${name}.model.generated.ts must be generated`);
    return artifact.content.split('\n')
      .filter(line => /^(export )?type \w+ = /.test(line) && /\b(priority|mixed)\b/.test(line))
      .map(line => line.replace(/\bT[AB](?![a-z])/g, 'T'));
  };
  const fromA = fieldLines('a');
  assert.ok(fromA.length > 0, 'generated type aliases must mention the union fields');
  assert.deepEqual(fromA, fieldLines('b'));
});
