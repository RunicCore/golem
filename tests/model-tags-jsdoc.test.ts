// lane: typescript6 forEachChild of the TypeScript 6 shim, which must visit the JSDoc of a JavaScript file as TypeScript 7 does
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { generate } from '#model/generator';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { createModelProject } from './model-project.js';
import { tsSource } from './source-template.js';

// A tag written in a JSDoc type of a `.js` file of the program names a function like a tag written in TypeScript. `a` and `b` share one type,
// so the field names `b` and the JavaScript value carries `a`: a read that misses the JSDoc binds `b` alone and drops `a`. The refusal names both functions, and the JavaScript one by its place in the JSDoc.

const verbatim = (text: string) => {
  const strings: TemplateStringsArray = Object.assign([text], { raw: [text] });
  return tsSource(strings);
};

const tag = "import('@exprtlabs/golem/tags').TValidation<typeof a>";
const helpers = {
  'a @type tag': `import { a } from './rules.js';\n/** @type {string & ${tag}} */\nexport const held = '';\n`,
  'a @typedef tag': `import { a } from './rules.js';\n/** @typedef {string & ${tag}} Held */\n/** @type {Held} */\nexport const held = '';\n`,
} as const;

for (const [name, helper] of Object.entries(helpers)) test(`a function tag written in the JSDoc of a JavaScript file is read, not dropped: ${name}`, t => {
  // protects: T-1063 the TypeScript 6 forEachChild skipped JSDoc, so the function index missed the tag of `a` and the field bound `b` alone (R-55 no silent difference)
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-tags-jsdoc-', name: 'model-tags-jsdoc', linkWorkspaceNodeModules: true, allowJs: true });
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), "export const a: (v: string) => boolean = (v) => v !== '';\nexport const b: typeof a = (v) => v.length < 9;\n");
  fs.writeFileSync(path.join(sourceRoot, 'helper.js'), helper);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: verbatim("import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\nimport { held } from './helper.js';\n"),
    fields: verbatim('field: typeof held & TValidation<typeof b>'),
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1040.*This program writes the functions `a` \(.*helper\.js:\d+:\d+\), `b` \(.*a\.model\.ts/s);
});
