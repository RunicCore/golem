import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import * as ts from '@exprtlabs/golem/internal/ts';
import { runPipeline } from '#golem/cli';
import { GeneratorSessionResources } from '#golem/pipeline';
import { operationCodecRegistryPath } from '#golem/generated-paths';
import { createControllerFixture } from './fixture-templates/controllers/project.js';

const model = (name: string, fields: string, imports = ''): string => [
  "import type { IModel } from '@exprtlabs/golem/model';",
  imports,
  `export type ${name} = IModel<{ ${fields} }>;`,
  '',
].join('\n');

type OpenOptions = Parameters<ts.ProgramSession['openProgram']>[0];

const controller = [
  "import { Controller, Get } from '@nestjs/common';",
  "import type { THolder } from './holder.model.js';",
  "@Controller('catalog')",
  'export class CatalogController {',
  '  @Get()',
  '  list(): THolder { return undefined as never; }',
  '}',
  '',
].join('\n');

/** Models in two folders of one tsconfig: `src/holder.model.ts` holds a model of `lib/`, which no job lists and only an import reaches. */
function twoFolderProject(t: TestContext): string {
  return createControllerFixture(t, {
    prefix: 'golem-stub-opens-',
    packageName: 'stub-opens',
    links: 'workspace',
    tsconfig: {
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, experimentalDecorators: true, rootDir: '.', outDir: 'build' },
      include: ['src/**/*.ts', 'lib/**/*.ts'],
    },
    files: {
      'golem.yaml': 'version: 1\nmobx: false\nvalidation: true\ncontrollers:\n  - root: .\n    output: generated/openapi.json\n    info: { title: Stub API, version: "1" }\nmodels:\n  root: .\n',
      'src/catalog.controller.ts': controller,
      'src/holder.model.ts': model('THolder', 'shared: TShared', "import type { TShared } from '../lib/shared.model.js';"),
      'lib/shared.model.ts': model('TShared', 'name: string'),
    },
  });
}

function outputs(root: string): Record<string, string> {
  const files = ['generated/openapi.json', path.relative(root, operationCodecRegistryPath(root)), 'src/holder.model.generated.ts', 'lib/shared.model.generated.ts'];
  return Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
}

// protects: T-466 a model folder the tsconfig lists is stubbed in the first program, so a job opens one stub program, not two
test('the controllers and models jobs each open one stub program when every model lies in the tsconfig, and a rerun writes the same files', async (t: TestContext) => {
  const root = twoFolderProject(t);
  const yaml = path.join(root, 'golem.yaml');
  const opened: OpenOptions[] = [];
  const openProgram = ts.ProgramSession.prototype.openProgram;
  t.mock.method(ts.ProgramSession.prototype, 'openProgram', function (this: ts.ProgramSession, options: OpenOptions) {
    opened.push(options);
    return openProgram.call(this, options);
  });
  using session = new GeneratorSessionResources();

  const first = await runPipeline(yaml, { session });
  // The controllers job opens one program, and the models job one stub program and the program of its write gate.
  assert.equal(opened.length, 3);
  const clean = outputs(root);
  assert.match(clean['generated/openapi.json']!, /"TShared"/);

  // A watch run after an edit that changes no output: both jobs rerun on their warm sessions, because the models job reads the whole project.
  opened.length = 0;
  const edited = path.join(root, 'src/catalog.controller.ts');
  fs.appendFileSync(edited, '// edited\n');
  await runPipeline(yaml, { session, previous: first, changedInputs: [edited] });
  assert.equal(opened.length, 3);
  assert.deepEqual(outputs(root), clean);
});
