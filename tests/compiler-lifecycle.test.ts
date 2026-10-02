import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import * as ts from '@exprtlabs/golem/ts';
import { API } from '#golem/typescript-ts7';
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

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
}

interface ChildProcessSpawnPrototype {
  spawn(options: { readonly args?: readonly string[]; readonly [key: string]: unknown }): ChildProcess;
}

interface ApiChildTracker {
  readonly seen: () => number;
  readonly live: () => readonly ChildProcess[];
  readonly assertClosed: (label: string) => Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function trackApiChildren(t: TestContext): ApiChildTracker {
  const prototype = ChildProcess.prototype as unknown as ChildProcessSpawnPrototype;
  const original = prototype.spawn;
  const live = new Set<ChildProcess>();
  let count = 0;
  prototype.spawn = function trackedSpawn(
    this: ChildProcess,
    options: { readonly args?: readonly string[]; readonly [key: string]: unknown },
  ): ChildProcess {
    const args = options.args ?? [];
    const api = args.includes('--api');
    if (api) {
      count += 1;
      live.add(this);
      const release = (): void => { live.delete(this); };
      this.once('close', release);
      this.once('error', release);
    }
    try {
      return original.call(this, options);
    } catch (error) {
      if (api) live.delete(this);
      throw error;
    }
  };

  const stopLive = async (): Promise<void> => {
    for (const child of live) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    const deadline = Date.now() + 2_000;
    while (live.size > 0 && Date.now() < deadline) await delay(20);
  };

  t.after(async () => {
    prototype.spawn = original;
    await stopLive();
  });

  return {
    seen: () => count,
    live: () => [...live],
    assertClosed: async (label: string): Promise<void> => {
      const deadline = Date.now() + 2_000;
      while (live.size > 0 && Date.now() < deadline) await delay(20);
      assert.equal(live.size, 0, `${label} left TypeScript --api children alive while the parent remained alive`);
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
    profile: { mobx: false, validation: false, ajvStandalone: false, allowAny: false },
    models: [{
      id: 'fixture:money',
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

function throwAfterRealClose(t: TestContext, failure: Error): () => number {
  const prototype = API.prototype as unknown as {
    updateSnapshot(this: API, ...args: readonly unknown[]): unknown;
    close(this: API): void;
  };
  const originalUpdateSnapshot = prototype.updateSnapshot;
  const originalClose = prototype.close;
  const owned = new WeakSet<API>();
  let calls = 0;
  prototype.updateSnapshot = function updateSnapshotForTest(this: API, ...args: readonly unknown[]): unknown {
    owned.add(this);
    return originalUpdateSnapshot.call(this, ...args);
  };
  prototype.close = function closeWithFailure(this: API): void {
    const isOwned = owned.has(this);
    originalClose.call(this);
    if (!isOwned) return;
    calls += 1;
    throw failure;
  };
  t.after(() => {
    prototype.updateSnapshot = originalUpdateSnapshot;
    prototype.close = originalClose;
  });
  return () => calls;
}

function errorRecord(error: unknown): { readonly name?: unknown; readonly error?: unknown; readonly suppressed?: unknown; readonly cause?: unknown; readonly errors?: readonly unknown[] } {
  return error !== null && typeof error === 'object'
    ? error as { readonly name?: unknown; readonly error?: unknown; readonly suppressed?: unknown; readonly cause?: unknown; readonly errors?: readonly unknown[] }
    : {};
}

test('public model and controller generators close every owned API child across success, failure, empty, manifest, and concurrent paths', async t => {
  const tracker = trackApiChildren(t);
  const profile = { mobx: false, validation: false } as const;

  const model = projectFixture(t, 'compiler-lifecycle-model');
  const modelSource = path.join(model.sourceRoot, 'item.model.ts');
  fs.writeFileSync(modelSource, [
    "import type { IModel } from '@exprtlabs/golem/model';",
    'export type TItem = IModel<{ value: string }>;',
    '',
  ].join('\n'));
  assert.equal(generateModel({ root: model.root, sources: [modelSource], profile }).artifacts.length > 0, true);
  await tracker.assertClosed('model success');
  assert.equal(generateModel({ root: model.root, sources: [modelSource], profile }).artifacts.length > 0, true);
  await tracker.assertClosed('repeated model success');

  fs.writeFileSync(modelSource, 'export const notAModel = 1;\n');
  assert.throws(() => generateModel({ root: model.root, sources: [modelSource], profile }), /No exported IModel/);
  await tracker.assertClosed('model failure');
  fs.rmSync(modelSource);
  assert.deepEqual(generateModel({ root: model.root, profile }).artifacts, []);
  await tracker.assertClosed('empty model generation');

  const manifestFixture = projectFixture(t, 'compiler-lifecycle-manifest');
  const manifest = writeManifestFixture(manifestFixture);
  assert.throws(
    () => generateModel({ root: manifestFixture.root, sources: [manifest.source], profile, manifestInputs: [manifest.manifest] }),
    /missing runtime export/,
  );
  await tracker.assertClosed('manifest validation failure');

  const validController = projectFixture(t, 'compiler-lifecycle-controller');
  const validSource = path.join(validController.sourceRoot, 'items.controller.ts');
  fs.writeFileSync(validSource, readFixture('models/compiler-lifecycle/controller-success/items.controller.ts'));
  const validOutput = path.join(validController.root, 'openapi.json');
  const validResult = await generateController(controllerContext(validController.root, validSource, validOutput));
  assert.equal(validResult.artifacts.length > 0, true);
  await tracker.assertClosed('controller success');

  const invalidController = projectFixture(t, 'compiler-lifecycle-controller-failure');
  const invalidSource = path.join(invalidController.sourceRoot, 'items.controller.ts');
  fs.writeFileSync(invalidSource, readFixture('models/compiler-lifecycle/controller-duplicate/items.controller.ts'));
  await assert.rejects(
    generateController(controllerContext(invalidController.root, invalidSource, path.join(invalidController.root, 'openapi.json'))),
    /NEST1306: Route GET \/items\/same is declared more than once/,
  );
  await tracker.assertClosed('controller failure');

  const concurrentA = projectFixture(t, 'compiler-lifecycle-concurrent-a');
  const concurrentB = projectFixture(t, 'compiler-lifecycle-concurrent-b');
  const sourceA = path.join(concurrentA.sourceRoot, 'items.controller.ts');
  const sourceB = path.join(concurrentB.sourceRoot, 'items.controller.ts');
  fs.writeFileSync(sourceA, readFixture('models/compiler-lifecycle/controller-success/items.controller.ts'));
  fs.writeFileSync(sourceB, readFixture('models/compiler-lifecycle/controller-success/items.controller.ts'));
  const concurrent = await Promise.allSettled([
    generateController(controllerContext(concurrentA.root, sourceA, path.join(concurrentA.root, 'openapi.json'))),
    generateController(controllerContext(concurrentB.root, sourceB, path.join(concurrentB.root, 'openapi.json'))),
  ]);
  assert.equal(concurrent.every(result => result.status === 'fulfilled'), true);
  await tracker.assertClosed('concurrent controller generation');
  assert.ok(tracker.seen() >= 8, `expected API subprocesses from every lifecycle path, saw ${tracker.seen()}`);
});

test('compiler setup preserves the primary error and reports cleanup failure after closing the API child', async t => {
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-setup-failure');
  const primary = new Error('injected compiler setup failure');
  const cleanup = new Error('injected compiler cleanup failure');
  const closeCalls = throwAfterRealClose(t, cleanup);

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
      assert.deepEqual(record.errors, [record.cause, cleanup]);
      return true;
    },
  );
  assert.equal(closeCalls(), 1);
  assert.ok(tracker.seen() >= 1, 'setup failure did not reach the real TypeScript API child boundary');
  await tracker.assertClosed('compiler setup failure');
});

test('manifest validation shares one compiler across 5 and 50 generated model modules', async t => {
  const tracker = trackApiChildren(t);
  const counts: number[] = [];
  const profile = { mobx: false, validation: false } as const;
  for (const count of [5, 50]) {
    const fixture = projectFixture(t, `manifest-scale-${count}`);
    const sdk = path.join(fixture.sourceRoot, 'sdk');
    fs.mkdirSync(path.join(sdk, 'models'), { recursive: true });
    const manifestFile = path.join(sdk, 'model-manifest.json');
    const models = Array.from({ length: count }, (_, index) => {
      const names = manifestScaleNames({ index });
      return {
        id: `scale:item:${index}`,
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
      profile: { ...profile, ajvStandalone: false, allowAny: false }, models,
    }));
    const source = path.join(fixture.sourceRoot, 'aggregate.model.ts');
    fs.writeFileSync(source, readFixture('models/compiler-lifecycle/manifest-scale/aggregate.model.ts'));
    const before = tracker.seen();
    const result = generateModel({ root: fixture.root, sources: [source], profile });
    assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('aggregate.model.generated.ts')));
    counts.push(tracker.seen() - before);
    await tracker.assertClosed(`${count}-model manifest`);

    // A cached export table must still be rebuilt for the next generation job.
    if (count === 50) {
      fs.writeFileSync(path.join(sdk, 'models', 'Item49.ts'), 'export const RenamedModel = 1;\n');
      assert.throws(() => generateModel({ root: fixture.root, sources: [source], profile }), /missing runtime export Item49Model/);
      await tracker.assertClosed('changed manifest export');
    }
  }
  assert.ok(counts[0] > 0, 'the public generator must invoke the real compiler');
  assert.deepEqual(counts, [counts[0], counts[0]], 'compiler process count must not grow with manifest entries');
});

test('owned generator scope preserves its primary error when API cleanup also fails', async t => {
  const tracker = trackApiChildren(t);
  const fixture = projectFixture(t, 'compiler-lifecycle-scope-failure');
  const source = path.join(fixture.sourceRoot, 'not-a-model.model.ts');
  fs.writeFileSync(source, 'export const notAModel = 1;\n');
  const cleanup = new Error('injected scope cleanup failure');
  const closeCalls = throwAfterRealClose(t, cleanup);

  assert.throws(
    () => generateModel({ root: fixture.root, sources: [source], profile: { mobx: false, validation: false } }),
    (error: unknown) => {
      const record = errorRecord(error);
      assert.equal(record.name, 'SuppressedError');
      assert.equal(record.error, cleanup);
      assert.equal(record.suppressed instanceof Error, true);
      assert.match((record.suppressed as Error).message, /No exported IModel/);
      return true;
    },
  );
  assert.equal(closeCalls(), 1);
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
  assert.equal(tracker.seen(), 1, 'every program shares one compiler');

  const [compiler] = tracker.live();
  assert.ok(compiler);
  compiler.kill('SIGKILL');
  // TypeScript unrefs its compiler child, so awaiting only its exit event lets
  // the event loop drain; a ref'd timer keeps the test alive while it exits.
  const deadline = Date.now() + 2_000;
  while (compiler.exitCode === null && compiler.signalCode === null && Date.now() < deadline) await delay(20);
  assert.equal(compiler.signalCode, 'SIGKILL');
  assert.ok(open().inputs.has(imported), 'the replacement compiler opens the program');
  assert.equal(tracker.seen(), 2, 'an exited compiler is replaced once');
  session[Symbol.dispose]();
  await tracker.assertClosed('disposed program session');
});

function captureSnapshotRequests(t: TestContext): unknown[] {
  const prototype = API.prototype as unknown as { updateSnapshot(this: API, ...args: unknown[]): unknown };
  const original = prototype.updateSnapshot;
  const requests: unknown[] = [];
  prototype.updateSnapshot = function capturedUpdateSnapshot(this: API, ...args: unknown[]): unknown {
    requests.push(args[0]);
    return original.apply(this, args);
  };
  t.after(() => { prototype.updateSnapshot = original; });
  return requests;
}

/** Whether a snapshot update is running: the compiler's file system callbacks of a snapshot arrive while it is. */
function snapshotRunning(t: TestContext): () => boolean {
  const prototype = API.prototype as unknown as { updateSnapshot(this: API, ...args: unknown[]): unknown };
  const original = prototype.updateSnapshot;
  let running = false;
  prototype.updateSnapshot = function runningUpdateSnapshot(this: API, ...args: unknown[]): unknown {
    running = true;
    try {
      return original.apply(this, args);
    } finally {
      running = false;
    }
  };
  t.after(() => { prototype.updateSnapshot = original; });
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
  const prototype = API.prototype as unknown as { updateSnapshot(this: API, ...args: unknown[]): unknown };
  const original = prototype.updateSnapshot;
  let updates = 0;
  prototype.updateSnapshot = function crashingUpdateSnapshot(this: API, ...args: unknown[]): unknown {
    updates++;
    if (updates === 1) compiler.kill('SIGKILL');
    return original.apply(this, args);
  };
  t.after(() => { prototype.updateSnapshot = original; });

  fs.writeFileSync(imported, "export type Imported = { shape: 'second' };\n");
  session.inputsChanged([imported]);
  assert.match(diagnostics(), /'"first"' is not assignable to type '"second"'/, 'the replacement compiler reads the edited file');
  assert.equal(updates, 2, 'the failed update is retried once on a new compiler');
  // The exit event of the unref'd child arrives on a later turn; the loop bounds the wait, it is not a delay.
  const deadline = Date.now() + 2_000;
  while (compiler.exitCode === null && compiler.signalCode === null && Date.now() < deadline) await delay(20);
  assert.equal(compiler.signalCode, 'SIGKILL');
  assert.equal(tracker.seen(), 2, 'one replacement compiler');
  prototype.updateSnapshot = original;
  assert.equal(diagnostics().length > 0, true, 'the replacement stays warm for the next program');
  assert.equal(tracker.seen(), 2);
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
    assert.match(sibling.getSourceFile(main)?.text ?? '', /a: string/);
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
  const lastChanges = (): unknown => (requests.at(-1) as { readonly fileChanges?: unknown }).fileChanges;

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

// A tsconfig edit must reach the compiler's project however the edit and the compiler's reads interleave. The compiler
// can read or probe a tsconfig while a snapshot is built without applying it, and invalidating every file does not parse
// a tsconfig again; see ProgramSession in typescript-ts7.ts.
for (const hinted of [false, true]) {
  const how = hinted ? 'reported by the host' : 'found by the signatures';

  test(`a tsconfig edit that lands while the compiler probes the project is applied by the next program, ${how}`, t => {
    const project = pathMappedProject(t, 'compiler-lifecycle-probing-edit');
    const running = snapshotRunning(t);
    let edits = 0;
    let armed = false;
    const session = new ts.ProgramSession({ cwd: project.root });
    t.after(() => session[Symbol.dispose]());
    const open = (sources: readonly string[], virtual?: string): ts.Program => session.openProgram({
      root: project.root,
      sources,
      ...(virtual === undefined ? {} : {
        configFile: virtual,
        overlays: new Map([[virtual, JSON.stringify({ extends: './tsconfig.json', files: [...sources], include: [] })]]),
      }),
      onInput: filename => {
        if (!armed || !running() || filename !== project.tsconfig) return;
        armed = false;
        edits++;
        project.writeMapping('second');
      },
    });

    open([project.app]).close();
    // Another project takes over, then the first reopens from the tsconfig on disk.
    open([project.sdk], path.join(project.root, 'virtual.json')).close();
    open([project.app]).close();
    // Opening files in a directory the compiler has not searched makes it probe the tsconfig without reading it.
    armed = true;
    using stale = open([project.app, project.sdk]);
    assert.equal(edits, 1, 'the edit landed in the snapshot');
    assert.equal(project.mappingOf(stale), 'first', 'the program holds the project of the tsconfig it read');

    if (hinted) session.inputsChanged([project.tsconfig]);
    using current = open([project.app, project.sdk]);
    assert.equal(project.mappingOf(current), 'second', 'the next program applies the edit');
  });

  test(`a tsconfig edit that lands in the snapshot after a full snapshot is applied by the next program, ${how}`, t => {
    const project = pathMappedProject(t, 'compiler-lifecycle-discovery-edit');
    const running = snapshotRunning(t);
    let edits = 0;
    let armed = false;
    const session = new ts.ProgramSession({ cwd: project.root });
    t.after(() => session[Symbol.dispose]());
    const open = (sources: readonly string[]): ts.Program => session.openProgram({
      root: project.root,
      sources,
      onInput: filename => {
        if (!armed || !running() || filename !== project.tsconfig) return;
        armed = false;
        edits++;
        project.writeMapping('second');
      },
    });

    open([project.app]).close();
    // A manifest change invalidates module resolution: a full snapshot, which does not parse the tsconfig again.
    project.changeManifest();
    open([project.app]).close();
    armed = true;
    open([project.app, project.sdk]).close();
    assert.equal(edits, 1, 'the edit landed in the snapshot');

    if (hinted) session.inputsChanged([project.tsconfig]);
    using current = open([project.app, project.sdk]);
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
    const [reported, invalidated] = requests.slice(-2) as { readonly fileChanges?: { readonly changed?: readonly string[]; readonly invalidateAll?: boolean } }[];
    assert.ok(reported?.fileChanges?.changed?.includes(project.tsconfig), 'the tsconfig is reported as changed before every file is invalidated');
    assert.deepEqual(invalidated?.fileChanges, { invalidateAll: true });
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
  assert.throws(() => session.parseConfigFile(path.join(fixture.root, 'missing.json')), /could not read file/);
  assert.equal(tracker.seen(), 1);
  session.openProgram({ root: fixture.root, sources: [source] }).close();
  assert.equal(tracker.seen(), 1, 'a deterministic failure does not replace the compiler');
  assert.equal(tracker.live().length, 1);
});

// ProgramSession keeps its newest snapshot alive until the next one exists
// (ProgramSession.latest in typescript-ns.ts). TypeScript 7.0.2 reports changed
// files only against a live previous snapshot; after the previous snapshot is
// disposed, the client still serves its parsed files. When the stale assertion
// fails, the server reports changes after disposal and the session can
// dispose snapshots with their programs.
test('server change report: TypeScript 7.0.2 serves stale files after the previous snapshot is disposed', t => {
  const fixture = projectFixture(t, 'compiler-lifecycle-server-changes');
  const source = path.join(fixture.sourceRoot, 'value.ts');
  const configFile = path.join(fixture.root, 'tsconfig.json');
  const api = new API({ cwd: fixture.root });
  t.after(() => api.close());
  const read = (snapshot: ReturnType<API['updateSnapshot']>): string | undefined =>
    snapshot.getProject(configFile)?.program.getSourceFile(source)?.text;

  fs.writeFileSync(source, 'export const value = 1;\n');
  const live = api.updateSnapshot({ openProjects: [configFile] });
  assert.equal(read(live), 'export const value = 1;\n');
  fs.writeFileSync(source, 'export const value = 2;\n');
  const afterLive = api.updateSnapshot({ fileChanges: { changed: [source] } });
  assert.equal(read(afterLive), 'export const value = 2;\n', 'changes against a live snapshot are reported');
  live.dispose();

  afterLive.dispose();
  fs.writeFileSync(source, 'export const value = 3;\n');
  const afterDisposed = api.updateSnapshot({ fileChanges: { changed: [source] } });
  assert.equal(read(afterDisposed), 'export const value = 2;\n', 'the client keeps the disposed snapshot\'s parsed file');
});
