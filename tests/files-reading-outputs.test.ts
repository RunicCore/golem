import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import * as ts from '@exprtlabs/golem/internal/ts';
import { filesReadingOutputs } from '#golem/type-analysis/project';
import { createFixtureProject } from './fixture-project.js';

/** A project whose `@sdk/*` and `@mid/*` aliases name `sdk/` (the output of a later job, empty at first) and `mid/` (a source folder). */
function aliasedProject(t: TestContext): { write(file: string, text: string): void; run(): string[] } {
  const root = createFixtureProject(t, 'golem-reading-outputs-');
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('package.json', '{"type":"module"}');
  write('tsconfig.json', JSON.stringify({
    compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', paths: { '@sdk/*': ['./sdk/*'], '@mid/*': ['./mid/*'] } },
    include: ['src', 'mid'],
  }));
  return {
    write,
    // One run: a new session holds no file of an earlier run. The output files themselves are left out of the answer.
    run: () => {
      using session = new ts.ProgramSession({ cwd: root });
      using program = session.openProgram({ root, sources: [path.join(root, 'src/app.ts')] });
      return [...filesReadingOutputs(program, [path.join(root, 'sdk')])].map(file => path.relative(root, file)).filter(file => !file.startsWith('sdk')).sort();
    },
  };
}

test('a bare import that resolves into a job output links the same on the first run and the next', (t: TestContext) => {
  // protects: T-994 the link was made only once the output was on disk, so the first and the second run read different files
  const project = aliasedProject(t);
  project.write('src/app.ts', "import type { Money } from '@sdk/money.js';\nexport type App = Money;\n");

  const first = project.run();
  project.write('sdk/money.ts', 'export type Money = number;\n');
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
