import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { generate } from '#model/generator';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { tagsProject as fixture } from './support/model-tags-project.js';
import { tsSource } from './source-template.js';

// Two functions of one signature share one type, and a tag that reaches the field through a reader that the scan cannot follow shows the
// checker one tag for both. Each row has its own program: whether `b` alone binds depends on which functions the whole program writes in tags.

const verbatim = (text: string) => tsSource(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray);

type Outcome = { readonly bound: string } | { readonly refused: string };

/** The names of `candidates` that the generated files import, or the first line of the diagnostic that stopped generation. */
function generateField(t: TestContext, row: { rules: string; declarations: string; field: string; imports?: string }, candidates: readonly string[]): Outcome {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), row.rules);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: verbatim(`import type { TSerde, TValidation } from '@exprtlabs/golem/tags';\nimport { ${candidates.join(', ')} } from './rules.js';\n${row.declarations}`),
    fields: verbatim(`field: ${row.field}`),
  }).text);
  try {
    const generated = generate({ root, profile: { validation: true } }).artifacts.map(artifact => artifact.content).join('\n');
    const imported = (name: string): boolean => new RegExp(`^import \\{[^}]*\\b${name}\\b(?: as \\w+)?[^}]*\\} from`, 'm').test(generated);
    return { bound: candidates.filter(imported).join(',') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('RUNM1040')) throw error;
    return { refused: message };
  }
}

/** A read may bind every function that it writes, or it may refuse by name. It may not bind some and drop the rest. */
function assertNoSilentDrop(outcome: Outcome, written: string): void {
  if ('refused' in outcome) return assert.match(outcome.refused, /RUNM1040/);
  assert.equal(outcome.bound, written, 'every written function is bound, or generation refuses by name');
}

const validators = {
  copied: "export const c: (v: unknown) => boolean = (v) => v !== null;\nexport const a: (v: string) => boolean = (v) => v !== '';\nexport const b: typeof a = (v) => v.length < 9;",
} as const;
const held = 'declare function tagged(): string & TValidation<typeof a>;\nclass Holder { held = tagged(); }\n';
const valueOf = 'type ValueOf<T> = T extends { held: infer V } ? V : never;\n';
const beside = ' & TValidation<typeof b>';

// `Holder.held` carries `typeof a` through an inferred type, and the field writes its copy `b`.
const droppedRows = {
  'a generic object type indexed by the field': { declarations: `${held}${valueOf}type Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
  'a generic object type that holds the tag of the field': { declarations: `${held}${valueOf}type Box<T> = { v: ValueOf<T> & TValidation<typeof b> };\n`, field: 'Box<Holder>' },
  'a conditional type with a default argument': { declarations: `${held}type ValueOfD<T = Holder> = T extends { held: infer V } ? V : never;\n`, field: `ValueOfD${beside}` },
  'a generic class': { declarations: `${held}${valueOf}class BoxC<T> { v!: ValueOf<T>; }\n`, field: `BoxC<Holder>['v']${beside}` },
  'an object type with a default argument': { declarations: `${held}${valueOf}type W<T = Holder> = { v: ValueOf<T> };\n`, field: `W['v']${beside}` },
  'a Pick of the argument under a conditional type': { declarations: `${held}${valueOf}type Box<T extends { held: unknown }> = { v: ValueOf<Pick<T, 'held'>> };\n`, field: `Box<Holder>['v']${beside}` },
  'a class that extends a generic class': { declarations: `${held}${valueOf}class Base<T> { v!: ValueOf<T>; }\nclass Sub extends Base<Holder> {}\n`, field: `Sub['v']${beside}` },
  'a NonNullable conditional type': { declarations: `${held}type V<T> = NonNullable<T extends { held: infer X } ? X : never>;\n`, field: `V<Holder>${beside}` },
  'a conditional type in a union': { declarations: `${held}type V<T> = (T extends { held: infer X } ? X : never) | undefined;\n`, field: `NonNullable<V<Holder>>${beside}` },
  'a tag written through a generic tag alias': { declarations: `type Checked<F extends (...arguments_: never[]) => boolean> = string & TValidation<F>;\ndeclare function tagged(): Checked<typeof a>;\nclass Holder { held = tagged(); }\n${valueOf}type Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
  'a tag that a generic tag alias takes as its argument': { declarations: `type Tagged<F extends (...arguments_: never[]) => boolean> = string & TValidation<F>;\ntype Box<T> = { v: T };\n`, field: `Box<Tagged<typeof a>>['v']${beside}` },
  'an object that an inferred member wraps': { declarations: `declare function tagged(): string & TValidation<typeof a>;\nclass Holder { held = { inner: tagged() }; }\ntype ValueOf<T> = T extends { held: { inner: infer V } } ? V : never;\ntype Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
  'an array that an inferred member wraps': { declarations: `declare function tagged(): string & TValidation<typeof a>;\nclass Holder { held = [tagged()]; }\ntype ValueOf<T> = T extends { held: (infer V)[] } ? V : never;\ntype Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
} as const;

for (const [name, row] of Object.entries(droppedRows)) test(`a tag function that a generic reader hides from the scan is never dropped, read through ${name}`, t => {
  // protects: T-1058 the field showed one tag for `a` and `b`, and the scan read only `typeof b`, so `b` bound and the validator `a` that the tag also names was dropped (R-55 no silent difference)
  assertNoSilentDrop(generateField(t, { rules: validators.copied, ...row }, ['a', 'b', 'c']), 'a,b');
});

test('a generic reader over a value that holds no function tag binds the function that the field writes', t => {
  // protects: T-1058 a refusal that fires for every inferred member would stop a field that loses nothing
  const outcome = generateField(t, { rules: validators.copied, declarations: `class Holder { held = ''; }\n${valueOf}type Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` }, ['a', 'b', 'c']);
  assert.deepEqual(outcome, { bound: 'b' });
});

// Two functions of one signature that the checker tells apart: `typeof a` and `typeof b` are different types, so each tag names its function.
const distinctRules = {
  'two annotation texts': "export const a: (v: string) => boolean = (v) => v !== '';\nexport const b: (v: string) => boolean = (v) => v.length < 9;",
  'two function declarations': "export function a(v: string): boolean { return v !== ''; }\nexport function b(v: string): boolean { return v.length < 9; }",
  'two arrows without an annotation': "export const a = (v: string) => v !== '';\nexport const b = (v: string) => v.length < 9;",
} as const;
const distinctReaders = {
  'a generic object type': { declarations: `${held}${valueOf}type Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
  'a type with a default argument': { declarations: `${held}${valueOf}type W<T = Holder> = { v: ValueOf<T> };\n`, field: `W['v']${beside}` },
  'a class that extends a generic class': { declarations: `${held}${valueOf}class Base<T> { v!: ValueOf<T>; }\nclass Sub extends Base<Holder> {}\n`, field: `Sub['v']${beside}` },
} as const;

for (const [rulesName, rules] of Object.entries(distinctRules)) for (const [readerName, reader] of Object.entries(distinctReaders)) test(`two validators of one signature are both bound, written as ${rulesName} and read through ${readerName}`, t => {
  // protects: T-1058 functions whose types differ name themselves, so a reader that the scan cannot follow does not stop a field that loses nothing
  assert.deepEqual(generateField(t, { rules, ...reader }, ['a', 'b']), { bound: 'a,b' });
});

test('a serializer and a deserializer that copy the type of another pair are never dropped behind a generic reader', t => {
  // protects: T-1058 the same drop for TSerde: each role names its function by type, and the copies `s2` and `d2` share the types of `s` and `d`
  const rules = "export const s: (v: string) => string = (v) => v;\nexport const s2: typeof s = (v) => v.trim();\nexport const d: (w: string) => string = (w) => w;\nexport const d2: typeof d = (w) => w.trim();";
  const declarations = `declare function tagged(): string & TSerde<typeof s, typeof d>;\nclass Holder { held = tagged(); }\n${valueOf}type Box<T> = { v: ValueOf<T> };\n`;
  assertNoSilentDrop(generateField(t, { rules, declarations, field: "Box<Holder>['v'] & TSerde<typeof s2, typeof d2>" }, ['s', 's2', 'd', 'd2']), 's,s2,d,d2');
});
