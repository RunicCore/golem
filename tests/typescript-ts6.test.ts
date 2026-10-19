import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as ts from '@exprtlabs/golem/ts';
import { generate } from '#model/generator';
import { resolveTypeScript } from '#golem/typescript-version';
import { createFixtureProject } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tsSource } from './source-template.js';
import { write, editTsconfig, sourceOnlyProject, USE, mtimes, importBuilt, golemBuild, assertCallMap } from './support/build-project.js';

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

// The build paths whose compiler calls differ by version: `--showConfig` of forwarded arguments, the emit run's `--listEmittedFiles` lines and the incremental state. No `skip`: it runs on both versions.
test('golem build --declaration builds, runs and rebuilds incrementally, and a type error under --noEmitOnError emits nothing', async (t) => {
  const root = sourceOnlyProject(t, 'ts6-build');
  // The tsconfig does not ask for declarations, so only the forwarded argument can produce them: golem build must read it with --showConfig.
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.declaration = false; });
  write(root, 'src/use.ts', USE);
  // `Payment` is a class imported with `import type`: the build rewrites the call to construct it from a value import.
  write(root, 'src/load.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { Payment } from './money.model.js';
export function load(text: string) { return parse<Payment>(text); }
`);

  const first = await golemBuild(root, ['--declaration']);
  assert.equal(first.code, 0, `${first.stdout}${first.stderr}`);
  assert.match(fs.readFileSync(path.join(root, 'build/use.d.ts'), 'utf8'), /export declare const money: \{\s*currency: string;\s*value: string;\s*\};/);
  const { load } = await importBuilt(root, 'load.js') as { load: (text: string) => { amount: { currency: string } } };
  const { Payment } = await importBuilt(root, 'money.model.js') as { Payment: new (...args: never[]) => unknown };
  const payment = load('{"id":"1","amount":{"currency":"USD","value":"1"},"note":"n"}');
  assert.ok(payment instanceof Payment, 'the rewritten call constructs the class that was imported as a type');
  assert.equal(payment.amount.currency, 'USD');

  // An old fixed time on every built file: a file the rebuild writes again shows on any file-system clock.
  const old = new Date('2001-01-01T00:00:00Z');
  for (const file of mtimes(path.join(root, 'build'), '.js').keys()) fs.utimesSync(path.join(root, 'build', file), old, old);
  const emitted = mtimes(path.join(root, 'build'), '.js');
  write(root, 'src/use.ts', `${USE}export const again = stringify<TMoney>({ currency: 'EUR', value: '2' });\n`);
  const second = await golemBuild(root, ['--declaration']);
  assert.equal(second.code, 0, `${second.stdout}${second.stderr}`);
  const rebuilt = mtimes(path.join(root, 'build'), '.js');
  assert.deepEqual([...rebuilt].filter(([file, time]) => emitted.get(file) !== time).map(([file]) => file), ['use.js'], 'only the edited file is emitted again');
  assert.equal((await importBuilt(root, 'use.js')).again, '{"currency":"EUR","value":"2"}');
  assertCallMap(root, 'build/use.js', 'src/use.ts');

  write(root, 'src/broken.ts', "export const n: number = 'text';\n");
  const jsBefore = mtimes(path.join(root, 'build'), '.js');
  const declarationsBefore = mtimes(path.join(root, 'build'), '.d.ts');
  const third = await golemBuild(root, ['--declaration', '--noEmitOnError']);
  assert.notEqual(third.code, 0);
  assert.match(`${third.stdout}${third.stderr}`, /src\/broken\.ts\(1,14\): error TS2322/);
  assert.deepEqual(mtimes(path.join(root, 'build'), '.js'), jsBefore, 'no JavaScript is emitted');
  assert.deepEqual(mtimes(path.join(root, 'build'), '.d.ts'), declarationsBefore, 'no declaration is emitted');
  assert.equal(jsBefore.has('broken.js'), false);
});
