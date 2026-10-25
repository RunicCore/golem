// lane: typescript6 getLeadingCommentRanges and getTrailingCommentRanges of the classic API: the manifest marker is read from comments
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createProjectProgram } from '@exprtlabs/golem/internal/type-analysis';
import { advertisedModelManifests } from '#golem/type-analysis/provenance';
import { createFixtureProject } from './fixture-project.js';

const SOURCES: Readonly<Record<string, string>> = {
  'leading.ts': '/* @golem-model-manifest ./leading.json */\nexport const a = 1;\n',
  'between.ts': "import type { A } from './leading.js';\n/* @golem-model-manifest ./between.json */\nexport type B = typeof A;\n",
  'trailing.ts': 'export const c = 1; // @golem-model-manifest ./trailing.json\nexport const d = 2;\n',
  // The marker text in a string or a template is code, not a comment: it names no manifest, and `./in-string.json` does not exist.
  'string.ts': "export const note = '/* @golem-model-manifest ./in-string.json */';\nexport const tail = `@golem-model-manifest ./in-template.json`;\n",
};

test('a model manifest is advertised by a comment between statements, never by a string that holds the marker text', (t) => {
  // protects: T-293 a regex over the file text read the marker inside a string literal and reported a missing manifest
  const root = createFixtureProject(t, 'golem-manifest-marker-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true }, include: ['*.ts'] }));
  for (const [file, text] of Object.entries(SOURCES)) fs.writeFileSync(path.join(root, file), text);
  for (const manifest of ['leading', 'between', 'trailing']) fs.writeFileSync(path.join(root, `${manifest}.json`), '{}');
  const info = createProjectProgram(root, undefined, undefined, path.join(root, 'tsconfig.json'));
  t.after(() => info.program[Symbol.dispose]());
  const advertised = [...advertisedModelManifests(info.program)].map((file) => path.basename(file)).sort();
  assert.deepEqual(advertised, ['between.json', 'leading.json', 'trailing.json']);
});
