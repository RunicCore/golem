import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import * as ts from '@exprtlabs/golem/internal/ts';
import { filesReadingOutputs } from '#golem/type-analysis/project';
import { createFixtureProject } from './fixture-project.js';

/** A project whose `sdkPaths` aliases name `sdk/` (the output of a later job, empty at first) and whose `@mid/*` alias names `mid/` (a source folder). */
function aliasedProject(t: TestContext, sdkPaths: Record<string, string[]> = { '@sdk/*': ['./sdk/*'] }): { write(file: string, text: string): void; link(file: string, target: string): void; run(): string[] } {
  const root = createFixtureProject(t, 'golem-reading-outputs-');
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('package.json', '{"type":"module"}');
  write('tsconfig.json', JSON.stringify({
    compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', paths: { ...sdkPaths, '@mid/*': ['./mid/*'] } },
    include: ['src', 'mid'],
  }));
  return {
    write,
    // A symbolic link at `file` to `target`, as a package manager makes for a workspace package; it may point at a folder that is not there yet.
    link: (file, target) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.symlinkSync(target, path.join(root, file), 'dir');
    },
    // One run: a new session holds no file of an earlier run. The output files themselves are left out of the answer.
    run: () => {
      using session = new ts.ProgramSession({ cwd: root });
      using program = session.openProgram({ root, sources: [path.join(root, 'src/app.ts')] });
      return [...filesReadingOutputs(program, [path.join(root, 'sdk')])].map(file => path.relative(root, file)).filter(file => !file.startsWith('sdk')).sort();
    },
  };
}

test('an alias import that maps into a job output excludes its importer on the first run and the next', (t: TestContext) => {
  // protects: T-994 the importer was excluded only once the output was on disk, so the first and the second run read different files
  const project = aliasedProject(t);
  project.write('src/app.ts', "import type { Money } from '@sdk/money.js';\nexport type App = Money;\n");

  const first = project.run();
  project.write('sdk/money.ts', 'export type Money = number;\n');
  const second = project.run();

  assert.deepEqual([first, second], [['src/app.ts'], ['src/app.ts']]);
});

test('an alias import of a folder output by its index excludes its importer on the first run and the next', (t: TestContext) => {
  // protects: T-994 the index of a folder output is a file the job writes later too
  const project = aliasedProject(t);
  project.write('src/app.ts', "import type { Money } from '@sdk/index.js';\nexport type App = Money;\n");

  const first = project.run();
  project.write('sdk/index.ts', 'export type Money = number;\n');
  const second = project.run();

  assert.deepEqual([first, second], [['src/app.ts'], ['src/app.ts']]);
});

test('an alias that names one file of a folder output excludes its importer on the first run and the next', (t: TestContext) => {
  // protects: T-994 the target `./sdk/client.js` is no tail of the specifier `@sdk`
  const project = aliasedProject(t, { '@sdk': ['./sdk/client.js'] });
  project.write('src/app.ts', "import type { Money } from '@sdk';\nexport type App = Money;\n");

  const first = project.run();
  project.write('sdk/client.ts', 'export type Money = number;\n');
  const second = project.run();

  assert.deepEqual([first, second], [['src/app.ts'], ['src/app.ts']]);
});

test('an alias that maps into a sub-folder of a folder output excludes its importer on the first run and the next', (t: TestContext) => {
  // protects: T-994 the target `./sdk/v1/*` holds a folder that the specifier `@sdk/money.js` does not name
  const project = aliasedProject(t, { '@sdk/*': ['./sdk/v1/*'] });
  project.write('src/app.ts', "import type { Money } from '@sdk/money.js';\nexport type App = Money;\n");

  const first = project.run();
  project.write('sdk/v1/money.ts', 'export type Money = number;\n');
  const second = project.run();

  assert.deepEqual([first, second], [['src/app.ts'], ['src/app.ts']]);
});

test('an unresolved alias import that maps to no output says nothing on the first run and the next', (t: TestContext) => {
  // The control of the two cases above: a missing file outside the outputs is no reason to leave a file out.
  const project = aliasedProject(t);
  project.write('src/app.ts', "import type { Money } from '@mid/money.js';\nexport type App = Money;\n");

  const first = project.run();
  project.write('mid/money.ts', 'export type Money = number;\n');
  const second = project.run();

  assert.deepEqual([first, second], [[], []]);
});

test('a bare import of a source file that imports an output by a relative path links the same on the first run and the next', (t: TestContext) => {
  // The import of the intermediate file resolves in every run, so it links in every run.
  const project = aliasedProject(t);
  project.write('src/app.ts', "import type { Wrapped } from '@mid/wrapped.js';\nexport type App = Wrapped;\n");
  project.write('mid/wrapped.ts', "import type { Money } from '../sdk/money.js';\nexport type Wrapped = Money;\n");

  const first = project.run();
  project.write('sdk/money.ts', 'export type Money = number;\n');
  const second = project.run();

  assert.deepEqual([first, second], [['mid/wrapped.ts', 'src/app.ts'], ['mid/wrapped.ts', 'src/app.ts']]);
});

test('a package that a node_modules link points into a job output excludes its importer on the first run and the next', (t: TestContext) => {
  // protects: T-1015 the link `node_modules/sdk-pkg` leads to the output only once the job has written it, so the first run did not exclude the importer
  const project = aliasedProject(t);
  project.link('node_modules/sdk-pkg', '../sdk');
  project.write('src/app.ts', "import type { Money } from 'sdk-pkg/money.js';\nexport type App = Money;\n");

  const first = project.run();
  project.write('sdk/money.ts', 'export type Money = number;\n');
  const second = project.run();

  assert.deepEqual([first, second], [['src/app.ts'], ['src/app.ts']]);
});

test('a package that a node_modules link points into a job output excludes its importer on the first run and the next when the compiler keeps links', (t: TestContext) => {
  // protects: T-1015 with preserveSymlinks the import resolves under node_modules once the output exists, a path the closure did not test against the outputs
  const project = aliasedProject(t);
  project.write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', preserveSymlinks: true }, include: ['src'] }));
  project.link('node_modules/sdk-pkg', '../sdk');
  project.write('src/app.ts', "import type { Money } from 'sdk-pkg/money.js';\nexport type App = Money;\n");

  const first = project.run();
  project.write('sdk/money.ts', 'export type Money = number;\n');
  const second = project.run();

  assert.deepEqual([first, second], [['src/app.ts'], ['src/app.ts']]);
});
