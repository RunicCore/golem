// lane: typescript6 forEachChild of the TypeScript 6 shim, which walks the JSDoc types of a JavaScript file, as TypeScript 7 hoists them into its declarations
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { generate } from '#model/generator';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { createModelProject } from './model-project.js';
import { tsSource } from './source-template.js';
import { skipUnlessTypeScript6 } from './support/typescript-lane.js';

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

/** The message that generation stops with for a field that holds the tag of `a` through `helper.js`, and the tag of `b` itself. `rulesTail` is more source for `rules.ts`. */
function refusalOf(t: TestContext, helper: string, rulesTail = ''): string {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-tags-jsdoc-', name: 'model-tags-jsdoc', linkWorkspaceNodeModules: true, allowJs: true });
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), `export const a: (v: string) => boolean = (v) => v !== '';\nexport const b: typeof a = (v) => v.length < 9;\n${rulesTail}`);
  fs.writeFileSync(path.join(sourceRoot, 'helper.js'), helper);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: verbatim("import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\nimport { held } from './helper.js';\n"),
    fields: verbatim('field: typeof held & TValidation<typeof b>'),
  }).text);
  try {
    generate({ root, profile: { validation: true } });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail('generation must stop: the tag of `a` is in the JSDoc of helper.js');
}

for (const [name, helper] of Object.entries(helpers)) test(`a function tag written in the JSDoc of a JavaScript file is read, not dropped: ${name}`, t => {
  // protects: T-1063 the TypeScript 6 forEachChild skipped the JSDoc of a JavaScript file, so the function index missed the tag of `a` and the field bound `b` alone (R-55 no silent difference)
  assert.match(refusalOf(t, helper), /RUNM1040.*This program writes the functions `a` \(.*helper\.js:\d+:\d+\), `b` \(.*a\.model\.ts/s);
});

const inferredReason = /whose type golem infers; on TypeScript 6 a JSDoc `@type` does not count.*Declare each with `function`, or give each const its own type annotation\./s;

test('a JavaScript value with no type node is refused by name as inferred, with the remedy that works, on every TypeScript version', t => {
  // protects: T-1063 the reason named a TypeScript 6 limit for a value with no JSDoc and on TypeScript 7, where it was false
  const message = refusalOf(t, "export const held = '';\n", "import type { TValidation } from '@exprtlabs/golem/tags';\nexport type Other = string & TValidation<typeof a>;\n");
  assert.match(message, /RUNM1040.*through `held = ''` \(.*helper\.js:\d+:\d+\), /s);
  assert.match(message, inferredReason);
  assert.doesNotMatch(message, /annotation that writes the tag/);
});

test('TypeScript 6 keeps the JSDoc @type of a JavaScript value out of the type node, and the refusal says that it does not count', { skip: skipUnlessTypeScript6('TypeScript 7 reads the JSDoc type, which it hoists into the declaration') }, t => {
  // protects: T-1063 the text told the user that golem infers a type that the user had written in a JSDoc @type, and to annotate it
  const message = refusalOf(t, helpers['a @type tag']);
  assert.match(message, inferredReason);
  assert.doesNotMatch(message, /annotation that writes the tag/);
});
