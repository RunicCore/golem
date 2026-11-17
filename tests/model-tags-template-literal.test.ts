import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { generate } from '#model/generator';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tagsProject as fixture } from './support/model-tags-project.js';
import { tsSource } from './source-template.js';

// A template literal type holds a tag in one of its holes (`id-${string & MinLength<3>}`). The hole is a part of the value, not the value, so
// no tag of the field checks it: generation refuses by name, or the tag would be dropped without a message (R-55).

const verbatim = (text: string) => {
  const strings: TemplateStringsArray = Object.assign([text], { raw: [text] });
  return tsSource(strings);
};
const imports = "import type { MinLength, TValidation } from '@exprtlabs/golem/tags';\nimport { a } from './rules.js';\n";

function generateField(t: test.TestContext, declarations: string, field: string): string {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), "export const a: (v: string) => boolean = (v) => v !== '';");
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: verbatim(`${imports}${declarations}`), fields: verbatim(`field: ${field}`) }).text);
  return generate({ root, profile: { validation: true } }).artifacts.map(artifact => artifact.content).join('\n');
}

const refusedRows = {
  'a constraint tag in a hole of a template literal type': { declarations: '', field: '`id-${string & MinLength<3>}`' },
  'a function tag in a hole of a template literal type': { declarations: '', field: '`id-${string & TValidation<typeof a>}`' },
  'a tagged hole beside a tag of the field': { declarations: '', field: '`id-${string & MinLength<3>}` & MinLength<5>' },
  'a generic alias that fills a template literal type with a tagged hole': { declarations: 'type Id<T extends string> = `id-${T}`;\n', field: 'Id<string & MinLength<3>>' },
  'an array of template literal types that hold a tagged hole': { declarations: '', field: '(`id-${string & MinLength<3>}`)[]' },
} as const;

for (const [name, row] of Object.entries(refusedRows)) test(`generation refuses ${name} by name`, t => {
  // protects: T-1077 the tag in a hole was dropped without a message: the field read as a plain string (R-55 no silent difference)
  assert.throws(() => generateField(t, row.declarations, row.field), /RUNM1045: A tag inside the template literal type .* checks no value/);
});

test('a template literal type with no tag in its holes generates, also beside a tag of the field', t => {
  // protects: T-1077 the refusal reads the holes only, so a field with the tag beside the template literal type still generates
  assert.match(generateField(t, '', '`id-${string}` & MinLength<3>'), /codePointLength/);
});
