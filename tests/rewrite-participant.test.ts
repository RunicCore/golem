// The rewrite participant of an extension that a golem.yaml block turns on. The test extension is tests/fixtures/extensions/probe, which registers the block `probe`
// and the extension `mark`. Core runs its participant in golem check, golem build, Vite, esbuild and the Node loader alike.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';

import { resolveConfig } from '#golem/config';
import { runPipeline } from '#golem/cli';
import { golem as esbuildPlugin } from '#golem/esbuild';
import { openRewriteProject } from '#golem/rewrite-host';
import { golem as vitePlugin } from '#golem/vite';
import { copyFixture, copyFixtureFile, createFixtureProject, listProjectDependencies } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { build, golemBuild, write } from './support/build-project.js';
import { run } from './support/loader-project.js';
import { command, workspace } from './support/process.js';

const TURNED_ON = `version: 1
validation: false
model: {}
probe:
  extensions:
    mark:
      label: probe
      tagFile: tag.txt
`;

const TAG = 'declare function probeTag(): string;\nconsole.log(probeTag());\n';
const FAIL = 'declare function probeFail(): void;\nprobeFail();\n';
const BAD = 'declare function probeBad(): void;\nprobeBad();\n';
const WRAPPED = `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
import './money.model.js';

declare function probeWrap<T>(value: T): T;
export const money = probeWrap(parse<TMoney>('{"currency":"EUR","value":"2"}'));
`;

/** An app with the test extension installed, the money model, `src/main.ts` holding `main`, and `golem generate` done unless `generate` is false. */
async function app(t: TestContext, main: string, yaml = TURNED_ON, generate = true): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-extension-',
    name: 'extension-app',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
  });
  copyFixture(path.join(root, 'node_modules/@fixture/probe'), 'extensions/probe');
  listProjectDependencies(root, ['@fixture/probe']);
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'golem.yaml', yaml);
  write(root, 'tag.txt', 'hello\n');
  write(root, 'src/main.ts', main);
  if (generate) await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

/** Bundles `src/main.ts` of `root` with the bundler's golem plugin and returns what the bundle prints. */
async function bundled(t: TestContext, root: string, bundler: 'vite' | 'esbuild'): Promise<string> {
  const outDir = createFixtureProject(t, 'golem-extension-out-');
  if (bundler === 'vite') {
    await vite({ root, configFile: false, logLevel: 'silent', plugins: [vitePlugin()], build: { lib: { entry: 'src/main.ts', formats: ['es'], fileName: () => 'main.mjs' }, outDir, emptyOutDir: true, minify: false } });
  } else {
    await esbuild({ absWorkingDir: root, entryPoints: ['src/main.ts'], outfile: path.join(outDir, 'main.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [esbuildPlugin()] });
  }
  return (await command(root, process.execPath, [path.join(outDir, 'main.mjs')])).stdout;
}

test('the five hosts run the participant of the extension that the block turns on', async (t) => {
  // protects: R-94 a package registers an extension and core runs its rewrite participant in every host
  const root = await app(t, TAG);
  const printed = '[probe:hello]\n';

  await t.test('the Node loader', async () => {
    const result = await run(root, 'src/main.ts');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, printed);
  });
  await t.test('Vite', async () => {
    assert.equal(await bundled(t, root, 'vite'), printed);
  });
  await t.test('esbuild', async () => {
    assert.equal(await bundled(t, root, 'esbuild'), printed);
  });
  await t.test('golem build', async () => {
    assert.deepEqual(await build(root), { exitCode: 0 });
    assert.equal((await command(root, process.execPath, ['build/main.js'])).stdout, printed);
  });
  await t.test('golem check reports the diagnostic of the participant', async () => {
    write(root, 'src/main.ts', BAD);
    await assert.rejects(runPipeline(path.join(root, 'golem.yaml'), { check: true }), /PROBE0001.*probeBad\(\) is not allowed here/s);
  });
});

test('a participant that throws stops every host with the package named', async (t) => {
  // protects: D-115 a participant that throws stops the build
  const root = await app(t, FAIL);
  const fault = /Extension "mark" of @fixture\/probe \(block probe\) threw while it rewrote .*main\.ts: probe participant exploded\. This is a fault in @fixture\/probe/;

  await t.test('golem build', async () => {
    const result = await golemBuild(root, ['--config', path.join(root, 'golem.yaml')]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, fault);
  });
  await t.test('golem check', async () => {
    await assert.rejects(runPipeline(path.join(root, 'golem.yaml'), { check: true }), fault);
  });
  await t.test('the Node loader', async () => {
    const result = await run(root, 'src/main.ts');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, fault);
  });
  for (const bundler of ['vite', 'esbuild'] as const) {
    await t.test(bundler, async () => {
      await assert.rejects(bundled(t, root, bundler), fault);
    });
  }
});

test('an edit of a participant that covers text that core edits is an error, not a silent pick', async (t) => {
  // protects: R-94 edits of participants and of core never overlap silently
  const root = await app(t, WRAPPED);
  await assert.rejects(runPipeline(path.join(root, 'golem.yaml'), { check: true }), /RUNM1091.*Extension "mark" of @fixture\/probe edits \d+-\d+ of this file, which overlaps the edit at \d+-\d+ of core or of an extension/s);
});

test('the block entry is the only switch, and the files the participant read are the dependencies of the rewrite', async (t) => {
  // protects: R-93 a config entry is the only switch
  const off = await app(t, TAG, 'version: 1\nvalidation: false\nmodel: {}\nprobe: {}\n');
  const without = await openRewriteProject({ cwd: off });
  try {
    assert.equal(without.rewrite(path.join(off, 'src/main.ts'), TAG), undefined);
  } finally {
    without.close();
  }

  const on = await app(t, TAG);
  const rewriting = await openRewriteProject({ cwd: on });
  try {
    const file = path.join(on, 'src/main.ts');
    assert.deepEqual(rewriting.rewrite(file, TAG)?.dependencies, [path.join(on, 'tag.txt')]);
    write(on, 'tag.txt', 'changed\n');
    rewriting.changed([path.join(on, 'tag.txt')]);
    assert.match(rewriting.rewrite(file, TAG)?.code ?? '', /__golem_label\("probe:changed"\)/);
  } finally {
    rewriting.close();
  }
});

test('an extension the package does not register stops loading and lists the ones it registers', async (t) => {
  // protects: R-94 a block turns on only the extensions its package registers
  const root = await app(t, TAG, 'version: 1\nmodel: {}\nprobe:\n  extensions:\n    nope: {}\n', false);
  await assert.rejects(resolveConfig(path.join(root, 'golem.yaml')), /probe\.extensions turns on "nope", which @fixture\/probe does not register\. It registers: mark, note, stray, broken\./);
});

// A participant that returns a result the contract refuses: the options say which.
const BAD_RESULT = `export const extension = {
  rewrite({ options }) {
    if (options.result === 'promise') return (async () => ({ edits: [] }))();
    if (options.result === 'reads') return { reads: 'tag.txt' };
    return { diagnostics: {} };
  },
};
`;

test('a participant that returns a promise, reads that are no list of paths or diagnostics that are no list stops the run with the package named', async (t) => {
  // protects: T-786 an async rewrite is not a silent no-op, and a wrong reads or diagnostics is a fault of the package, not a TypeError
  const cases = [
    ['a promise', 'promise', /returned a promise for .*main\.ts; "rewrite" must return its result at once/],
    ['reads that are no array of paths', 'reads', /returned reads that are no array of file paths for .*main\.ts/],
    ['diagnostics that are no array of objects', 'diagnostics', /returned diagnostics that are no array of objects for .*main\.ts/],
  ] as const;
  for (const [name, result, message] of cases) {
    await t.test(name, async (u) => {
      const root = await app(u, TAG, `version: 1\nvalidation: false\nmodel: {}\nprobe:\n  extensions:\n    bad:\n      result: ${result}\n`, false);
      const installed = path.join(root, 'node_modules/@fixture/probe');
      write(installed, 'bad.mjs', BAD_RESULT);
      const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
      manifest.exports['./bad'] = './bad.mjs';
      manifest.golem.extensions.bad = './bad';
      write(installed, 'package.json', JSON.stringify(manifest));

      await runPipeline(path.join(root, 'golem.yaml'));

      await assert.rejects(runPipeline(path.join(root, 'golem.yaml'), { check: true }), (error: Error) => {
        assert.match(error.message, /Extension "bad" of @fixture\/probe \(block probe\)/);
        assert.match(error.message, message);
        assert.match(error.message, /This is a fault in @fixture\/probe/);
        return true;
      });
    });
  }
});
