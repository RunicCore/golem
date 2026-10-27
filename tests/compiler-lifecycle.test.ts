import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import * as ts from '@exprtlabs/golem/internal/ts';
import { createFixtureProject, readFixture } from './fixture-project.js';
import { generate as generateController } from '#controllers/generator';
import { generate as generateModel } from '#model/generator';
import {
  manifestScaleClassSource,
  manifestScaleNames,
  manifestScaleTypesSource,
} from './fixture-templates/models/compiler-lifecycle.js';
import { workspace } from './support/process.js';
import { pathMappedProject } from './support/path-mapped-project.js';
import { compilerChildren } from './support/generation-watch.js';
import { subscribe } from './support/golem-channels.js';

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
}

interface ApiChildTracker {
  /** How many compilers the sessions started. */
  readonly seen: () => number;
  /** The process ids of the compilers of this test that are still alive. */
  readonly live: () => readonly number[];
  /** The compiler processes the sessions started, in start order. */
  readonly started: () => readonly ChildProcess[];
  readonly assertClosed: (label: string) => Promise<void>;
  /** Waits until one compiler is gone. */
  readonly gone: (pid: number) => Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function trackApiChildren(t: TestContext): ApiChildTracker {
  // Compilers that were alive before this test belong to nobody here: the operating system's process list is the evidence.
  const before = new Set(compilerChildren(process.pid));
  // golem reports each compiler it starts; the process list is the evidence of what is alive.
  const started: (ChildProcess | undefined)[] = [];
  subscribe(t, 'compilerStarted', (message: { readonly compiler: ChildProcess | undefined }) => { started.push(message.compiler); });
  const live = (): number[] => compilerChildren(process.pid).filter(pid => !before.has(pid));
  const waitUntilGone = async (pids: readonly number[]): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (live().some(pid => pids.includes(pid)) && Date.now() < deadline) await delay(20);
  };
  t.after(async () => {
    const left = live();
    for (const pid of left) process.kill(pid, 'SIGTERM');
    await waitUntilGone(left);
  });

  return {
    seen: () => started.length,
    live,
    started: () => started.flatMap(compiler => compiler ?? []),
    assertClosed: async (label: string): Promise<void> => {
      await waitUntilGone(live());
      assert.deepEqual(live(), [], `${label} left TypeScript --api children alive while the parent remained alive`);
    },
    gone: async (pid: number): Promise<void> => {
      await waitUntilGone([pid]);
      assert.equal(live().includes(pid), false, `compiler ${pid} exited`);
    },
  };
}

function projectFixture(t: TestContext, name: string): Fixture {
  const root = createFixtureProject(t, `golem-${name}-`);
  const sourceRoot = path.join(root, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  }));
  return { root, sourceRoot };
}

function controllerContext(root: string, source: string, output: string) {
  return {
    root,
    sources: [source],
    output,
    info: { title: 'Lifecycle fixture', version: '1' },
    profile: { mobx: false, validation: false },
  } as const;
}

function writeManifestFixture(fixture: Fixture): { readonly source: string; readonly manifest: string } {
  const sdk = path.join(fixture.sourceRoot, 'sdk');
  fs.mkdirSync(sdk, { recursive: true });
  const types = path.join(sdk, 'types.ts');
  const generated = path.join(sdk, 'models.ts');
  const manifest = path.join(sdk, 'model-manifest.json');
  const source = path.join(fixture.sourceRoot, 'aggregate.model.ts');
  fs.writeFileSync(types, '/* @golem-model-manifest ./model-manifest.json */\nexport interface Money { currency: string }\n');
  fs.writeFileSync(generated, 'export const Other = 1;\n');
  fs.writeFileSync(manifest, JSON.stringify({
    profile: { mobx: false, validation: false, allowAny: false, unknownFormats: 'error' },
    models: [{
      id: 'fixture:money',
      codecId: 'Money_0a1b2c3d',
      allowAny: false,
      type: { module: './types.ts', export: 'Money' },
      generated: { module: './models.ts', export: 'MoneyModel' },
    }],
  }));
  fs.writeFileSync(source, [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { Money } from './sdk/types.js';",
    'export type TAggregate = IModel<{ money: Money }>;',
    '',
  ].join('\n'));
  return { source, manifest };
}

/**
 * Subscribe to the snapshot requests a program session sends. TypeScript 7.1 sends the first request with `createSnapshot` and later
 * ones through the newest snapshot; golem publishes both before it sends. A subscriber runs inside the publish, so it acts at the
 * moment the request is about to go. `settled` runs when the request has ended. The returned function unsubscribes both.
 */
function observeSnapshots(t: TestContext, requested: (request: unknown) => void, settled?: () => void): () => void {
  const stopRequested = subscribe(t, 'snapshotRequested', (message: { readonly request: unknown }) => { requested(message.request); });
  const stopSettled = subscribe(t, 'snapshotSettled', () => { settled?.(); });
  return () => { stopRequested(); stopSettled(); };
}

/**
 * Makes the closing of the next compilers fail for real: after golem kills the compiler, the TypeScript API writes its timing
 * record to the folder `TS_API_TIMING_DIR` names, and that name is a file. Returns how many compilers golem reported closed.
 */
function failTimingRecordOnClose(t: TestContext): { readonly closed: () => number; readonly failure: (error: unknown) => boolean } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-timing-dir-')), 'not-a-folder');
  fs.writeFileSync(file, '');
  const previous = process.env.TS_API_TIMING_DIR;
  process.env.TS_API_TIMING_DIR = file;
  t.after(() => {
    if (previous === undefined) delete process.env.TS_API_TIMING_DIR; else process.env.TS_API_TIMING_DIR = previous;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
  let closed = 0;
  subscribe(t, 'compilerClosed', () => { closed += 1; });
  return { closed: () => closed, failure: error => error instanceof Error && /^(EEXIST|ENOTDIR)$/.test(String((error as NodeJS.ErrnoException).code)) };
}

function errorRecord(error: unknown): { readonly name?: unknown; readonly error?: unknown; readonly suppressed?: unknown; readonly cause?: unknown; readonly errors?: readonly unknown[] } {
  return error !== null && typeof error === 'object'
    ? error as { readonly name?: unknown; readonly error?: unknown; readonly suppressed?: unknown; readonly cause?: unknown; readonly errors?: readonly unknown[] }
    : {};
}

const lifecycleProfile = { mobx: false, validation: false } as const;

function modelSourceFixture(t: TestContext, name: string): { readonly fixture: Fixture; readonly source: string } {
  const fixture = projectFixture(t, name);
  const source = path.join(fixture.sourceRoot, 'item.model.ts');
  fs.writeFileSync(source, [
    "import type { IModel } from '@exprtlabs/golem/model';",
    'export type TItem = IModel<{ value: string }>;',
    '',
  ].join('\n'));
  return { fixture, source };
}

function controllerFixture(t: TestContext, name: string, example: string): { readonly fixture: Fixture; readonly source: string; readonly output: string } {
  const fixture = projectFixture(t, name);
  const source = path.join(fixture.sourceRoot, 'items.controller.ts');
  fs.writeFileSync(source, readFixture(`models/compiler-lifecycle/${example}/items.controller.ts`));
  return { fixture, source, output: path.join(fixture.root, 'openapi.json') };
}

// Each path below ends with no TypeScript --api child alive while the test process runs.
test('a model generation that succeeds closes its API child, also when repeated', async t => {
  // protects: a successful model generation, also a repeated one, leaves no TypeScript API process running
  const tracker = trackApiChildren(t);
  const { fixture, source } = modelSourceFixture(t, 'compiler-lifecycle-model');
  assert.equal(generateModel({ root: fixture.root, sources: [source], profile: lifecycleProfile }).artifacts.length > 0, true);
  await tracker.assertClosed('model success');
  assert.equal(generateModel({ root: fixture.root, sources: [source], profile: lifecycleProfile }).artifacts.length > 0, true);
  await tracker.assertClosed('repeated model success');
  assert.ok(tracker.seen() >= 2, `expected API subprocesses from both generations, saw ${tracker.seen()}`);
});

test('a model generation that fails closes its API child', async t => {
  // protects: a model generation that throws leaves no TypeScript API process running
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-model-failure');
  const source = path.join(fixture.sourceRoot, 'item.model.ts');
  fs.writeFileSync(source, 'export const notAModel = 1;\n');
  assert.throws(() => generateModel({ root: fixture.root, sources: [source], profile: lifecycleProfile }), /No exported IModel/);
  await tracker.assertClosed('model failure');
  assert.ok(tracker.seen() >= 1, `expected an API subprocess from the failed generation, saw ${tracker.seen()}`);
});

test('a model generation with no sources closes its API child', async t => {
  // protects: a model generation with no sources leaves no TypeScript API process running
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-model-empty');
  assert.deepEqual(generateModel({ root: fixture.root, profile: lifecycleProfile }).artifacts, []);
  await tracker.assertClosed('empty model generation');
});

test('a manifest validation failure closes the API child', async t => {
  // protects: a manifest validation failure leaves no TypeScript API process running
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-manifest');
  const manifest = writeManifestFixture(fixture);
  assert.throws(
    () => generateModel({ root: fixture.root, sources: [manifest.source], profile: lifecycleProfile, manifestInputs: [manifest.manifest] }),
    /missing runtime export/,
  );
  await tracker.assertClosed('manifest validation failure');
  assert.ok(tracker.seen() >= 1, `expected an API subprocess from the manifest validation, saw ${tracker.seen()}`);
});

test('a controller generation that succeeds closes its API child', async t => {
  // protects: a successful controller generation leaves no TypeScript API process running
  const tracker = trackApiChildren(t);
  const valid = controllerFixture(t, 'compiler-lifecycle-controller', 'controller-success');
  const result = await generateController(controllerContext(valid.fixture.root, valid.source, valid.output));
  assert.equal(result.artifacts.length > 0, true);
  await tracker.assertClosed('controller success');
  assert.ok(tracker.seen() >= 1, `expected an API subprocess from the controller generation, saw ${tracker.seen()}`);
});

test('a controller generation that fails closes its API child', async t => {
  // protects: a controller generation that rejects leaves no TypeScript API process running
  const tracker = trackApiChildren(t);
  const invalid = controllerFixture(t, 'compiler-lifecycle-controller-failure', 'controller-duplicate');
  await assert.rejects(
    generateController(controllerContext(invalid.fixture.root, invalid.source, invalid.output)),
    /NEST1306: Route GET \/items\/same is declared more than once/,
  );
  await tracker.assertClosed('controller failure');
  assert.ok(tracker.seen() >= 1, `expected an API subprocess from the failed controller generation, saw ${tracker.seen()}`);
});

test('two concurrent controller generations close their API children', async t => {
  // protects: two controller generations at once each leave no TypeScript API process running
  const tracker = trackApiChildren(t);
  const a = controllerFixture(t, 'compiler-lifecycle-concurrent-a', 'controller-success');
  const b = controllerFixture(t, 'compiler-lifecycle-concurrent-b', 'controller-success');
  const concurrent = await Promise.allSettled([
    generateController(controllerContext(a.fixture.root, a.source, a.output)),
    generateController(controllerContext(b.fixture.root, b.source, b.output)),
  ]);
  assert.equal(concurrent.every(result => result.status === 'fulfilled'), true);
  await tracker.assertClosed('concurrent controller generation');
  assert.ok(tracker.seen() >= 2, `expected API subprocesses from both generations, saw ${tracker.seen()}`);
});

test('compiler setup preserves the primary error and reports cleanup failure after closing the API child', async t => {
  // protects: a failing close of the compiler never hides the error that stopped the setup, and the process still ends
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-setup-failure');
  const primary = new Error('injected compiler setup failure');
  const closing = failTimingRecordOnClose(t);

  assert.throws(
    () => ts.createProgramFromSources({
      root: fixture.root,
      sources: [],
      onInput: () => { throw primary; },
    }),
    (error: unknown) => {
      const record = errorRecord(error);
      assert.equal(record.name, 'AggregateError');
      // The native RPC boundary wraps callback failures before returning them.
      assert.ok(record.cause instanceof Error);
      assert.match(record.cause.message, /injected compiler setup failure/);
      assert.equal(record.errors?.length, 2);
      assert.equal(record.errors?.[0], record.cause);
      assert.equal(closing.failure(record.errors?.[1]), true, 'the second error is the failed close');
      return true;
    },
  );
  assert.equal(closing.closed(), 1);
  assert.ok(tracker.seen() >= 1, 'setup failure did not reach the real TypeScript API child boundary');
  await tracker.assertClosed('compiler setup failure');
});

/** A project whose manifest lists `count` generated model modules, and the model source that aggregates them. */
function manifestScaleFixture(t: TestContext, count: number): { readonly fixture: Fixture; readonly sdk: string; readonly source: string } {
  const fixture = projectFixture(t, `manifest-scale-${count}`);
  const sdk = path.join(fixture.sourceRoot, 'sdk');
  fs.mkdirSync(path.join(sdk, 'models'), { recursive: true });
  const manifestFile = path.join(sdk, 'model-manifest.json');
  const models = Array.from({ length: count }, (_, index) => {
    const names = manifestScaleNames({ index });
    return {
      id: `scale:item:${index}`,
      codecId: `${names.item}_${index.toString(16).padStart(8, '0')}`,
      allowAny: false,
      type: { module: './types.ts', export: names.item },
      generated: { module: `./models/${names.item}.ts`, export: names.generatedClass },
    };
  });
  fs.writeFileSync(path.join(sdk, 'types.ts'), manifestScaleTypesSource({ count }).text);
  for (let index = 0; index < count; index++) {
    const { item } = manifestScaleNames({ index });
    fs.writeFileSync(path.join(sdk, 'models', `${item}.ts`), manifestScaleClassSource({ index }).text);
  }
  fs.writeFileSync(manifestFile, JSON.stringify({
    profile: { ...lifecycleProfile, allowAny: false, unknownFormats: 'error' }, models,
  }));
  const source = path.join(fixture.sourceRoot, 'aggregate.model.ts');
  fs.writeFileSync(source, readFixture('models/compiler-lifecycle/manifest-scale/aggregate.model.ts'));
  return { fixture, sdk, source };
}

// One compiler serves a generation however many models its manifest lists, so each size spawns the same single process.
for (const count of [5, 50]) {
  test(`manifest validation shares one compiler across ${count} generated model modules`, async t => {
    const tracker = trackApiChildren(t);
    const { fixture, source } = manifestScaleFixture(t, count);
    const result = generateModel({ root: fixture.root, sources: [source], profile: lifecycleProfile });
    assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('aggregate.model.generated.ts')));
    assert.equal(tracker.seen(), 1, 'the public generator must invoke the real compiler once, however many manifest entries');
    await tracker.assertClosed(`${count}-model manifest`);
  });
}

test('a cached manifest export table is rebuilt for the next generation job', async t => {
  const tracker = trackApiChildren(t);
  const { fixture, sdk, source } = manifestScaleFixture(t, 50);
  generateModel({ root: fixture.root, sources: [source], profile: lifecycleProfile });
  fs.writeFileSync(path.join(sdk, 'models', 'Item49.ts'), 'export const RenamedModel = 1;\n');
  assert.throws(() => generateModel({ root: fixture.root, sources: [source], profile: lifecycleProfile }), /missing runtime export Item49Model/);
  await tracker.assertClosed('changed manifest export');
});

test('owned generator scope preserves its primary error when API cleanup also fails', async t => {
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-scope-failure');
  const source = path.join(fixture.sourceRoot, 'not-a-model.model.ts');
  fs.writeFileSync(source, 'export const notAModel = 1;\n');
  const closing = failTimingRecordOnClose(t);

  assert.throws(
    () => generateModel({ root: fixture.root, sources: [source], profile: { mobx: false, validation: false } }),
    (error: unknown) => {
      const record = errorRecord(error);
      assert.equal(record.name, 'SuppressedError');
      assert.equal(closing.failure(record.error), true, 'the error is the failed close');
      assert.equal(record.suppressed instanceof Error, true);
      assert.match((record.suppressed as Error).message, /No exported IModel/);
      return true;
    },
  );
  assert.equal(closing.closed(), 1);
  assert.ok(tracker.seen() >= 1, 'scope failure did not reach the real TypeScript API child boundary');
  await tracker.assertClosed('owned generator scope failure');
});

test('a reused program session replays recorded inputs, sees file changes and replaces an exited compiler', async t => {
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-session');
  const importer = path.join(fixture.sourceRoot, 'importer.ts');
  const imported = path.join(fixture.sourceRoot, 'imported.ts');
  fs.writeFileSync(importer, "import type { Imported } from './imported.js';\nexport const value: Imported = { shape: 'first' };\n");
  const session = new ts.ProgramSession({ cwd: fixture.root });
  t.after(() => session[Symbol.dispose]());
  const open = (): { readonly inputs: ReadonlySet<string>; readonly diagnostics: readonly string[] } => {
    const inputs = new Set<string>();
    using program = session.openProgram({ root: fixture.root, sources: [importer], onInput: filename => inputs.add(filename) });
    return { inputs, diagnostics: ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.text ?? '') };
  };

  const missing = open();
  assert.ok(missing.inputs.has(imported), 'the failed resolution probe is an input');
  assert.match(missing.diagnostics.join('\n'), /Cannot find module '\.\/imported\.js'/);
  // A warm compiler does not probe again; the session still reports the input.
  assert.ok(open().inputs.has(imported), 'a later program reports the recorded probe');

  fs.writeFileSync(imported, "export type Imported = { shape: 'first' };\n");
  assert.deepEqual(open().diagnostics, [], 'a created file is read');
  fs.writeFileSync(imported, "export type Imported = { shape: 'second' };\n");
  assert.match(open().diagnostics.join('\n'), /'"first"' is not assignable to type '"second"'/, 'a changed file is read');
  fs.rmSync(imported);
  assert.match(open().diagnostics.join('\n'), /Cannot find module '\.\/imported\.js'/, 'a deleted file is not served from the cache');
  const [compiler, ...others] = tracker.live();
  assert.ok(compiler);
  assert.deepEqual(others, [], 'every program shares one compiler');
  process.kill(compiler, 'SIGKILL');
  await tracker.gone(compiler);
  assert.ok(open().inputs.has(imported), 'the replacement compiler opens the program');
  assert.equal(tracker.live().length, 1, 'an exited compiler is replaced by one');
  assert.equal(tracker.live().includes(compiler), false);
  session[Symbol.dispose]();
  await tracker.assertClosed('disposed program session');
});

// The compiler server prints `context canceled` to the inherited stderr when SIGTERM reaches it between its last
// response and its next read. Whether it does depends on scheduling, so the test pins the cause instead: the session
// ends the compiler with SIGKILL, which the server cannot report on.
test('closing a program session ends the compiler with a signal it cannot report on', async t => {
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-close');
  const source = path.join(fixture.sourceRoot, 'value.ts');
  fs.writeFileSync(source, 'export const value = 1;\n');
  const session = new ts.ProgramSession({ cwd: fixture.root });
  t.after(() => session[Symbol.dispose]());
  {
    using program = session.openProgram({ root: fixture.root, sources: [source] });
    assert.deepEqual(ts.getPreEmitDiagnostics(program), []);
  }
  // The exit signal is only on the child object, which golem reports when it starts the compiler.
  const [compiler] = tracker.started();
  assert.ok(compiler);
  assert.equal(tracker.live().length, 1);
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(resolve => {
    compiler.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // TypeScript unrefs its compiler child; a ref'd timer keeps the event loop alive until it exits.
  const keepAlive = setTimeout(() => undefined, 10_000);
  session[Symbol.dispose]();
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
  clearTimeout(keepAlive);
});

function captureSnapshotRequests(t: TestContext): unknown[] {
  const requests: unknown[] = [];
  observeSnapshots(t, request => { requests.push(request); });
  return requests;
}

/** Whether a snapshot update is running: the compiler's file system callbacks of a snapshot arrive while it is. */
function snapshotRunning(t: TestContext): () => boolean {
  let running = false;
  observeSnapshots(t, () => { running = true; }, () => { running = false; });
  return () => running;
}

test('a compiler that exits during a snapshot update is replaced and the program reflects the latest files', async t => {
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-crash-in-update');
  const importer = path.join(fixture.sourceRoot, 'importer.ts');
  const imported = path.join(fixture.sourceRoot, 'imported.ts');
  fs.writeFileSync(importer, "import type { Imported } from './imported.js';\nexport const value: Imported = { shape: 'first' };\n");
  fs.writeFileSync(imported, "export type Imported = { shape: 'first' };\n");
  const session = new ts.ProgramSession({ cwd: fixture.root });
  t.after(() => session[Symbol.dispose]());
  const diagnostics = (): string => {
    using program = session.openProgram({ root: fixture.root, sources: [importer] });
    return ts.getPreEmitDiagnostics(program).map(diagnostic => diagnostic.text ?? '').join('\n');
  };
  assert.equal(diagnostics(), '');
  const [compiler] = tracker.live();
  assert.ok(compiler);

  // Kill the warm compiler as the next snapshot update is sent, so the request itself fails.
  let updates = 0;
  const unwatch = observeSnapshots(t, () => {
    updates++;
    if (updates === 1) process.kill(compiler, 'SIGKILL');
  });

  fs.writeFileSync(imported, "export type Imported = { shape: 'second' };\n");
  session.inputsChanged([imported]);
  assert.match(diagnostics(), /'"first"' is not assignable to type '"second"'/, 'the replacement compiler reads the edited file');
  assert.equal(updates, 2, 'the failed update is retried once on a new compiler');
  // The exit event of the unref'd child arrives on a later turn; the loop bounds the wait, it is not a delay.
  await tracker.gone(compiler);
  const [replacement, ...others] = tracker.live();
  assert.ok(replacement);
  assert.deepEqual(others, [], 'one replacement compiler');
  unwatch();
  assert.equal(diagnostics().length > 0, true, 'the replacement stays warm for the next program');
  assert.deepEqual(tracker.live(), [replacement]);
  session[Symbol.dispose]();
  await tracker.assertClosed('program session after an update crash');
});

test('a program stays consistent while a sibling program opens with different overlays', t => {
  const fixture = projectFixture(t, 'compiler-lifecycle-identity');
  const main = path.join(fixture.sourceRoot, 'main.ts');
  fs.writeFileSync(main, 'export type A = { a: number };\nexport const x: A = { a: 1 };\n');
  const session = new ts.ProgramSession({ cwd: fixture.root });
  t.after(() => session[Symbol.dispose]());
  using first = session.openProgram({ root: fixture.root, sources: [main] });
  const file = first.getSourceFile(main);
  assert.ok(file);
  {
    using sibling = session.openProgram({
      root: fixture.root,
      sources: [main],
      overlays: new Map([[main, 'export type A = { a: string };\nexport const x: A = { a: "1" };\n']]),
    });
    assert.equal(sibling.getSourceFile(main)?.text, 'export type A = { a: string };\nexport const x: A = { a: "1" };\n');
  }
  assert.equal(first.getSourceFile(main), file, 'nodes of an open program keep their identity');
});

test('host-reported and module-resolution changes invalidate the warm compiler, and a full snapshot prunes recorded inputs', t => {
  const requests = captureSnapshotRequests(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-invalidate');
  const importer = path.join(fixture.sourceRoot, 'importer.ts');
  const imported = path.join(fixture.sourceRoot, 'imported.ts');
  fs.writeFileSync(importer, "import type { Imported } from './imported.js';\nexport type Value = Imported;\n");
  const session = new ts.ProgramSession({ cwd: fixture.root });
  t.after(() => session[Symbol.dispose]());
  const open = (): ReadonlySet<string> => {
    const inputs = new Set<string>();
    session.openProgram({ root: fixture.root, sources: [importer], onInput: filename => inputs.add(filename) }).close();
    return inputs;
  };
  const lastChanges = (): unknown => (requests.at(-1) as { readonly fileNotifications?: unknown }).fileNotifications;

  assert.ok(open().has(imported));
  open();
  assert.equal(lastChanges(), undefined, 'an unchanged project sends no file changes');

  // An edit within the timestamp resolution leaves the signature unchanged;
  // the host's report still reaches the compiler.
  session.inputsChanged([importer]);
  open();
  assert.deepEqual(lastChanges(), { changed: [importer], created: undefined, deleted: undefined }, 'the host report reaches the compiler as a changed file even when the edit leaves the signature unchanged');
  session.inputsChanged([path.join(fixture.root, 'unrelated.json')]);
  open();
  assert.equal(lastChanges(), undefined, 'a change to a path the compiler never read is ignored');

  // The import no longer probes the missing file. A package manifest change
  // invalidates module resolution, and the full snapshot drops the stale probe.
  fs.writeFileSync(importer, 'export type Value = string;\n');
  fs.writeFileSync(path.join(fixture.sourceRoot, 'package.json'), '{"type":"module"}');
  const inputs = open();
  assert.equal(inputs.has(imported), false, 'a full snapshot replaces the recorded inputs');
  assert.equal(open().has(imported), false);
});

// A tsconfig edit must reach the compiler's project however the edit and the compiler's reads interleave. On TypeScript 7.1
// the reachable interleaving is an edit that lands inside a full snapshot: a snapshot that opens no new project reads no
// tsconfig, and golem opens no file on its own; see ProgramSession in typescript-ts7.ts.
for (const hinted of [false, true]) {
  const how = hinted ? 'reported by the host' : 'found by the signatures';

  test(`a tsconfig edit that lands inside a full snapshot is applied by the next program, ${how}`, t => {
    const project = pathMappedProject(t, 'compiler-lifecycle-edit-inside-full-snapshot');
    const running = snapshotRunning(t);
    let edits = 0;
    let armed = false;
    const session = new ts.ProgramSession({ cwd: project.root });
    t.after(() => session[Symbol.dispose]());
    const open = (): ts.Program => session.openProgram({
      root: project.root,
      sources: [project.app],
      onInput: () => {
        if (!armed || !running()) return;
        armed = false;
        edits++;
        project.writeMapping('second');
      },
    });

    open().close();
    // A manifest change forces a full snapshot, and the edit lands at the first input that snapshot reports. The compiler
    // keeps its parsed configuration through the invalidation, so the record of the tsconfig must stay older than the edit.
    project.changeManifest();
    armed = true;
    using full = open();
    assert.equal(edits, 1, 'the edit landed inside the full snapshot');
    assert.equal(project.mappingOf(full), 'first', 'the program holds the configuration the compiler parsed');

    if (hinted) session.inputsChanged([project.tsconfig]);
    using current = open();
    assert.equal(project.mappingOf(current), 'second', 'the next program applies the edit');
  });

  test(`a tsconfig edit made with a manifest edit is applied by the full snapshot the manifest needs, ${how}`, t => {
    const project = pathMappedProject(t, 'compiler-lifecycle-full-snapshot-edit');
    const requests = captureSnapshotRequests(t);
    const session = new ts.ProgramSession({ cwd: project.root });
    t.after(() => session[Symbol.dispose]());
    const open = (): ts.Program => session.openProgram({ root: project.root, sources: [project.app] });

    using first = open();
    assert.equal(project.mappingOf(first), 'first');
    project.writeMapping('second');
    project.changeManifest();
    if (hinted) session.inputsChanged([project.tsconfig, project.manifest]);
    using second = open();
    assert.equal(project.mappingOf(second), 'second', 'the full snapshot applies the tsconfig edit');
    const [reported, invalidated] = requests.slice(-2) as { readonly fileNotifications?: { readonly changed?: readonly string[]; readonly invalidateAll?: boolean } }[];
    assert.ok(reported?.fileNotifications?.changed?.includes(project.tsconfig), 'the tsconfig is reported as changed before every file is invalidated');
    assert.deepEqual(invalidated?.fileNotifications, { invalidateAll: true });
  });
}

test('a configuration error keeps the warm compiler running', async t => {
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-deterministic');
  const source = path.join(fixture.sourceRoot, 'value.ts');
  fs.writeFileSync(source, 'export const value = 1;\n');
  const session = new ts.ProgramSession({ cwd: fixture.root });
  t.after(() => session[Symbol.dispose]());
  session.openProgram({ root: fixture.root, sources: [source] }).close();
  const warm = tracker.live();
  assert.equal(warm.length, 1);
  assert.throws(() => session.parseConfigFile(path.join(fixture.root, 'missing.json')), /could not read file/);
  session.openProgram({ root: fixture.root, sources: [source] }).close();
  assert.deepEqual(tracker.live(), warm, 'a deterministic failure does not replace the compiler');
});

