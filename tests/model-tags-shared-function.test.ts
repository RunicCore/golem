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

const verbatim = (text: string) => {
  const strings: TemplateStringsArray = Object.assign([text], { raw: [text] });
  return tsSource(strings);
};

type Outcome = { readonly bound: string } | { readonly refused: string };

/** The names of `candidates` that the generated files import, or the first line of the diagnostic that stopped generation. */
function generateField(t: TestContext, row: { rules: string; declarations: string; field: string; files?: Readonly<Record<string, string>> }, candidates: readonly string[]): Outcome {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), row.rules);
  for (const [name, text] of Object.entries(row.files ?? {})) fs.writeFileSync(path.join(sourceRoot, name), text);
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
  'a tag function that a type alias of typeof gives a generic tag alias': { declarations: `type Fa = typeof a;\ntype Checked<F extends (...arguments_: never[]) => boolean> = string & TValidation<F>;\ndeclare function tagged(): Checked<Fa>;\nclass Holder { held = tagged(); }\n${valueOf}type Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
  'a tag function that a generic call infers from its argument': { declarations: `declare function tag<F extends (v: string) => boolean>(f: F): string & TValidation<F>;\nclass Holder { held = tag(a); }\n${valueOf}type Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
  'a tag function that an indexed access of a type argument gives the tag': { declarations: `type Wrap<T extends { f: (...arguments_: never[]) => boolean }> = string & TValidation<T['f']>;\ndeclare function tagged(): Wrap<{ f: typeof a }>;\nclass Holder { held = tagged(); }\n${valueOf}type Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
  'a tag that an import type writes with an alias argument': { declarations: `type Fa = typeof a;\ndeclare function tagged(): string & import('@exprtlabs/golem/tags').TValidation<Fa>;\nclass Holder { held = tagged(); }\n${valueOf}type Box<T> = { v: ValueOf<T> };\n`, field: `Box<Holder>['v']${beside}` },
  'a renamed tag, and a call in a file that names neither typeof nor a tag': {
    declarations: `import { held } from './helper.js';\n`,
    field: `typeof held${beside}`,
    files: {
      'tags.ts': "export type { TValidation as Valid } from '@exprtlabs/golem/tags';\n",
      'lib.ts': "import type { Valid } from './tags.js';\nexport declare function tag<F extends (v: string) => boolean>(f: F): string & Valid<F>;\n",
      'helper.ts': "import { a } from './rules.js';\nimport { tag } from './lib.js';\nconst alias = a;\nexport const held = tag(alias);\n",
    },
  },
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

test('a class value is read while two serializers share one type, and binds the pair that the field writes', t => {
  // protects: T-1061 the walk stopped at a constructor, a set accessor, a function type, a call signature, a type predicate and an import type, so a class value that holds them refused a tag whose functions the program writes
  const members = [
    'constructor(readonly cents: number) {}',
    'static { void 0; }',
    'set label(value: string) {}',
    'apply!: (done: (money: Money) => void) => void;',
    'shape!: { (x: number): string };',
    'is(value: unknown): value is Money { return true; }',
    "other!: import('./rules.js').Other;",
  ].join('\n  ');
  const rules = [
    'export interface Other { n: number }',
    `export class Money {\n  ${members}\n}`,
    'export const s: (v: Money) => string = (v) => String(v.cents);',
    'export const s2: typeof s = (v) => String(v.cents + 1);',
    'export const d: (w: string) => Money = (w) => new Money(Number(w));',
    'export const d2: typeof d = (w) => new Money(Number(w) + 1);',
  ].join('\n');
  const declarations = "declare function tagged(): string & TSerde<typeof s, typeof d>;\nclass Holder { held = tagged(); }\ntype Price = Money & TSerde<typeof s2, typeof d2>;\n";
  assert.deepEqual(generateField(t, { rules, declarations, field: 'Price' }, ['Money', 's', 's2', 'd', 'd2']), { bound: 'Money,s2,d2' });
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

// The walk reads a field only as far as it can follow, and refuses by name where it cannot (`reach`). A kind that tsc resolves and that holds no tag is read through,
// so the field binds the function that it writes; a module that holds a tag is read, so a function that the tag names is never dropped.
const heldIn = 'declare function tagged(): string & TValidation<typeof a>;\nclass Holder { held = tagged(); }\n';
const neutral = (kind: string) => `type Neutral = unknown extends (${kind}) ? unknown : unknown;\n`;
const taggedImports = "import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a } from './rules.js';\n";
const taggedModule = `${taggedImports}export const w: string & TValidation<typeof a> = '';`;
const nestedModule = `${taggedImports}export namespace N { export const w: string & TValidation<typeof a> = ''; }`;
const kindRows = {
  'an enum member': { declarations: `enum Color { Red, Blue }\n${neutral('Color.Red')}`, files: {} },
  'a namespace that an interface merges with': { declarations: `interface Shape { n: number }\nnamespace Shape { export const k: number = 1; }\n${neutral('Shape')}`, files: {} },
  'a namespace that an enum merges with': { declarations: `enum Mode { A }\nnamespace Mode { export const k: number = 1; }\n${neutral('Mode')}`, files: {} },
  'a const that shares the name of a type': { declarations: `const Mode = { A: 1 } as const;\ntype Mode = 'a' | 'b';\n${neutral('Mode')}`, files: {} },
  'a namespace of an unannotated const that an interface merges with': { declarations: `interface Shape { n: number }\nnamespace Shape { export const k = 1; }\n${neutral('Shape')}`, files: {} },
  'a namespace of an unannotated const that an enum merges with': { declarations: `enum Mode { A }\nnamespace Mode { export const k = 1; }\n${neutral('Mode')}`, files: {} },
  'a namespace import of a module that holds no tag': { declarations: `import * as ns from './plain.js';\n${neutral('typeof ns')}`, files: { 'plain.ts': "export const k: string = '';\nexport type OnlyType = { z: 1 };" } },
  'an import type with no qualifier': { declarations: neutral("typeof import('./plain.js')"), files: { 'plain.ts': "export const k: string = '';" } },
  'a nested namespace and a namespace export that hold no tag': {
    declarations: `import * as plainNested from './plain-nested.js';\n${neutral('typeof plainNested')}`,
    files: { 'plain-nested.ts': "export namespace N { export const k: string = ''; }\nexport * as sub from './plain-inner.js';", 'plain-inner.ts': "export const k: string = '';" },
  },
  'an import type of a module that writes export =': { declarations: neutral("import('./single.js')"), files: { 'single.ts': 'class Single { n: number = 0 }\nexport = Single;' } },
} as const;

for (const [name, row] of Object.entries(kindRows)) test(`a field that the walk reads through ${name} binds the function that it writes`, t => {
  // protects: T-1069 the walk refused the field with "a kind of node that golem does not follow" for a kind that tsc resolves and that holds no tag (RUNM1040 refuses only what tsc cannot type)
  assert.deepEqual(generateField(t, { rules: validators.copied, declarations: `${heldIn}${row.declarations}`, field: `string${beside} & Neutral`, files: row.files }, ['a', 'b', 'c']), { bound: 'b' });
});

const moduleRows = {
  'a namespace import': { declarations: "import * as tagged from './tagged.js';\n" + neutral('typeof tagged'), files: { 'tagged.ts': taggedModule } },
  'an import type with no qualifier': { declarations: neutral("typeof import('./tagged.js')"), files: { 'tagged.ts': taggedModule } },
  'a namespace that the module exports': { declarations: "import * as tagged from './tagged.js';\n" + neutral('typeof tagged'), files: { 'tagged.ts': nestedModule } },
  'an import type over a namespace that the module exports': { declarations: neutral("typeof import('./tagged.js')"), files: { 'tagged.ts': nestedModule } },
  'a module that `export * as` names': { declarations: "import * as tagged from './tagged.js';\n" + neutral('typeof tagged'), files: { 'tagged.ts': "export * as sub from './inner.js';", 'inner.ts': taggedModule } },
} as const;

for (const [name, row] of Object.entries(moduleRows)) test(`a tag that a module holds is read through ${name} and shares its type with the function of the field`, t => {
  // protects: T-1069 the walk must read the exports of a module that `typeof` names, nested namespaces and `export * as` included, so the tag `a` in it is seen and the field is refused for the shared type, never bound to `b` alone
  const outcome = generateField(t, { rules: validators.copied, declarations: row.declarations, field: `string${beside} & Neutral`, files: row.files }, ['a', 'b', 'c']);
  assert.match('refused' in outcome ? outcome.refused : `bound ${outcome.bound}`, /shares its type with another function/);
});
