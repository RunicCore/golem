import { copyFixture, copyFixtureFile, readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getValidator } from '@exprtlabs/golem/validation';
import { tagsProject as fixture } from './support/model-tags-project.js';
import { buildModelProjectWith, generatedModelFiles } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { joinSource, tsSource, type SourceFragment } from './source-template.js';
import { generate } from '#model/generator';
import { modelCodec } from './support/model-codec.js';

test('tag bindings are AST-provenanced, alias-deduplicated, and relocation-stable', async t => {
  const build = (sourceRoot: string): void => {
    copyFixture(sourceRoot, 'models/model-tags/tag-bindings-are-ast-provenanced-alias-deduplicated-and-relocation-stable');
    fs.writeFileSync(path.join(sourceRoot, 'one', 'a.model.ts'), taggedModelSource({
      name: 'A',
      imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';
import { reexported, validateAlias } from './index.js';`,
      fields: tsSource`value: string & TValidation<typeof reexported> & TValidation<typeof validateAlias>`,
    }).text);
    fs.writeFileSync(path.join(sourceRoot, 'two', 'a.model.ts'), taggedModelSource({
      name: 'A',
      imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';
import { validate } from './validators.js';`,
      fields: tsSource`value: string & TValidation<typeof validate>`,
    }).text);
  };
  const first = fixture(t);
  build(first.sourceRoot);
  await buildModelProjectWith(first.root, { validation: true });
  const firstArtifacts = generatedModelFiles(first.root);
  const firstShared = firstArtifacts.filter((artifact) => artifact.path.endsWith('.model.generated.ts')).map((artifact) => artifact.content).join('\n');
  assert.ok(firstShared);
  // protects: security: generated files do not leak the absolute path of the build machine
  assert.doesNotMatch(firstShared, new RegExp(first.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const firstValidators = firstArtifacts.find((artifact) => artifact.path.endsWith('/models.validators.generated.ts'))?.content ?? '';
  assert.doesNotMatch(firstValidators, new RegExp(first.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((firstValidators.match(/^import \{ \w+ as v\d+ \} from /gm) ?? []).length, 2, 'same-signature functions from separate declarations remain distinct');

  const second = fixture(t);
  build(second.sourceRoot);
  const secondResult = generate({ root: second.root, profile: { validation: true } });
  const firstByRelative = new Map(firstArtifacts.map(artifact => [path.relative(first.root, artifact.path), artifact.content]));
  // The codec key table is core's own record, not one of the job's files, and the first run's map does not hold it.
  for (const artifact of secondResult.artifacts.filter(candidate => path.basename(candidate.path) !== 'codec-keys.json')) {
    assert.equal(artifact.content, firstByRelative.get(path.relative(second.root, artifact.path)), path.relative(second.root, artifact.path));
  }
});

test('extended JSON Schema tags preserve sibling keywords in generated validation', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { AdditionalProperties, Contains, DependentRequired, DependentSchemas, IfThenElse, MaxContains, MaxProperties, MinContains, MinItems, MinProperties, Not, OneOf, Pattern, PatternProperties, PropertyNames, UnevaluatedProperties } from '@exprtlabs/golem/tags';
type ValueObject = { foo?: string; bar?: string; x_value?: number };
type ValueArray = Array<string>;`,
    fields: tsSource`values: ValueArray & Contains<string & Pattern<'^ok$'>> & MinItems<1> & MinContains<1> & MaxContains<2>; objectValue: ValueObject & MinProperties<1> & MaxProperties<3> & PropertyNames<string & Pattern<'^[a-z_]+$'>> & PatternProperties<{ '^x_': number; '^z_': boolean }> & AdditionalProperties<never> & UnevaluatedProperties<never> & DependentRequired<{ foo: ['bar'] }> & DependentSchemas<{ foo: { bar: string } }> & OneOf<[{ foo: string }, { bar: string }]> & Not<{ forbidden: string }> & IfThenElse<{ bar: string }, { bar: string }, { foo: string }>;`,
  }).text);
  await buildModelProjectWith(root, { validation: true });
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const valid = new A({ values: ['ok'], objectValue: { bar: 'yes', x_value: 1 } });
  assert.equal(await getValidator(valid).validate(), true);
  for (const invalid of [
    { values: ['bad'], objectValue: { foo: 'only' } },
    { values: [], objectValue: { bar: 'yes' } },
    { values: ['ok', 'ok', 'ok'], objectValue: { bar: 'yes' } },
    { values: ['ok'], objectValue: {} },
    { values: ['ok'], objectValue: { foo: 'x', bar: 'y' } },
    { values: ['ok'], objectValue: { forbidden: 'x' } },
    { values: ['ok'], objectValue: { 'Bad-Key': 'x' } },
    { values: ['ok'], objectValue: { x_value: 'bad' } },
    { values: ['ok'], objectValue: { z_flag: 'bad' } },
  ]) {
    assert.equal(await getValidator(new A(invalid as never)).validate(), false, JSON.stringify(invalid));
  }
});

// One project holds every validation=true, non-standalone case that compiles and executes; each case keeps
// its own directory, so file and class names never collide. Cases that assert a diagnostic, or use another
// profile, keep projects of their own.
test('validation-on tag cases share one generated project', async t => {
  const { root, sourceRoot } = fixture(t);
  const tags = (name: string, file: string): string => readFixture(`models/model-tags/${name}/${file}`);
  const write = (directory: string, files: Readonly<Record<string, string>>): void => {
    fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(sourceRoot, directory, name), text);
  };
  write('builtin-order', {
    'predicates.ts': tags('builtin-constraints-run-before-custom-predicates-and-distinct-predicates-com', 'predicates.ts'),
    'a.model.ts': taggedModelSource({
      name: 'A',
      imports: tsSource`import type { MinLength, TValidation } from '@exprtlabs/golem/tags';
import { first, second } from './predicates.js';`,
      fields: tsSource`value: string & MinLength<3> & TValidation<typeof first> & TValidation<typeof first> & TValidation<typeof second>`,
    }).text,
  });
  write('structural-isolation', {
    'a.model.ts': taggedModelSource({
      name: 'A',
      imports: tsSource`import type { AdditionalProperties, MinProperties } from '@exprtlabs/golem/tags';`,
      fields: tsSource`value: { a?: string } & MinProperties<1> & AdditionalProperties<never>`,
    }).text,
    'b.model.ts': taggedModelSource({
      name: 'B',
      imports: tsSource`import type { AdditionalProperties, MinProperties } from '@exprtlabs/golem/tags';`,
      fields: tsSource`value: { b?: string } & MinProperties<1> & AdditionalProperties<never>`,
    }).text,
  });
  write('nested-issues', {
    'a.model.ts': taggedModelSource({
      name: 'A',
      imports: tsSource`import type { AdditionalProperties, MinLength } from '@exprtlabs/golem/tags';\ntype Value = { name: string & MinLength<3> };`,
      fields: tsSource`value: Value & AdditionalProperties<never>`,
    }).text,
  });
  // The shared-project Child of 'generic-aliases' is a different model, so this case names its own Leaf.
  write('nested-contains', {
    'leaf.model.ts': taggedModelSource({ name: 'Leaf', fields: tsSource`name: string` }).text,
    'a.model.ts': taggedModelSource({
      name: 'A',
      imports: tsSource`import type { Contains } from '@exprtlabs/golem/tags';\nimport type { TLeaf } from './leaf.model.js';`,
      fields: tsSource`children: unknown[] & Contains<TLeaf>`,
      options: tsSource`{ allowAny: true }`,
    }).text,
  });
  write('union-branches', {
    'predicates.ts': tags('union-branch-predicates-stay-attached-to-their-checker-constituent', 'predicates.ts'),
    'a.model.ts': taggedModelSource({
      name: 'A',
      imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { numberValue, stringValue } from './predicates.js';`,
      fields: tsSource`value: (string & TValidation<typeof stringValue>) | (number & TValidation<typeof numberValue>)`,
    }).text,
  });
  write('utility-aliases', {
    'predicates.ts': tags('utility-aliases-preserve-two-distinct-same-signature-predicates-and-deduplic', 'predicates.ts'),
    'a.model.ts': taggedModelSource({
      name: 'A',
      imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { first, firstAlias, second } from './predicates.js';\ntype Tagged<T extends string> = T & TValidation<typeof first> & TValidation<typeof firstAlias> & TValidation<typeof second>;\ntype Box<T> = { value: T };\ntype Payload = Partial<Pick<Box<Tagged<string>>, 'value'>>;`,
      fields: tsSource`payload: Payload`,
    }).text,
  });
  write('generic-aliases', {
    'child.model.ts': taggedModelSource({ name: 'Child', fields: tsSource`name: string` }).text,
    'parent.model.ts': tags('generic-aliases-preserve-concrete-local-model-identity-for-nested-conversion', 'parent.model.ts'),
  });
  write('recursive-alias', {
    'node.model.ts': taggedModelSource({ name: 'Node', fields: tsSource`name: string; children?: TNode[]` }).text,
  });
  write('mapped-templates', {
    'a.model.ts': taggedModelSource({
      name: 'A',
      imports: tsSource`import type { MaxLength, MinLength, PatternProperties } from '@exprtlabs/golem/tags';
type X = { '^x_': string & MaxLength<3> };
type Y = { '^y_': string & MinLength<2> };
type OneA = { a: string & MaxLength<3> };
type OtherA = { a: string & MinLength<2> };
type Plain = { [K in keyof OneA]: string };
type Dictionary = { [key: string]: string };`,
      fields: tsSource`dropped: Dictionary & PatternProperties<{ [K in keyof X]: string }>; droppedOverIntersection: Dictionary & PatternProperties<{ [K in keyof (X & Y)]: string }>; keptThroughMappedTemplate: Dictionary & PatternProperties<{ [K in keyof X]: X[K] }>; plain: Plain; both: Pick<OneA & OtherA, 'a'>`,
    }).text,
  });
  write('compound-bases', {
    'a.model.ts': taggedModelSource({
      name: 'A',
      imports: tsSource`import type { MinItems, MinLength, MinProperties } from '@exprtlabs/golem/tags';\ntype NonEmpty<T> = T[] & MinItems<1>;\ntype Page<T> = { items: T[] } & MinProperties<1>;`,
      fields: tsSource`parts: { a: string } & { b: number } & MinProperties<1>; before: { readonly __brand: 'Id' } & string & MinLength<3>; after: string & { readonly __brand: 'Id' } & MinLength<3>; list: NonEmpty<string>; page: Page<string>; legacy: string & { readonly _brand: 'Id' } & MinLength<3>; state: ('on' | 'off') & { readonly __brand: 'S' } & MinLength<1>`,
    }).text,
  });
  await buildModelProjectWith(root, { validation: true });
  const load = (directory: string, file: string) => import(path.toNamespacedPath(path.join(root, 'build', directory, file)));

  await t.test('builtin constraints run before custom predicates and distinct predicates compose once', async () => {
    const { A } = await load('builtin-order', 'a.model.js');
    const predicates = await load('builtin-order', 'predicates.js');
    const invalid = new A({ value: 'x' });
    assert.equal(await getValidator(invalid).validate({ failFast: false }), false);
    assert.equal(predicates.calls, 0, 'custom callbacks are suppressed when builtins fail');
    const valid = new A({ value: 'long' });
    assert.equal(await getValidator(valid).validate({ failFast: false }), true);
    assert.equal(predicates.calls, 2, 'same node deduplicates one predicate while distinct predicates both run');
  });

  await t.test('structural tag schemas remain isolated when constraints are equal', async () => {
    const { A } = await load('structural-isolation', 'a.model.js');
    const { B } = await load('structural-isolation', 'b.model.js');
    assert.equal(await getValidator(new A({ value: { a: 'ok' } })).validate(), true);
    assert.equal(await getValidator(new B({ value: { b: 'ok' } })).validate(), true);
    assert.equal(await getValidator(new A({ value: { b: 'wrong-shape' } } as never)).validate(), false);
    assert.equal(await getValidator(new B({ value: { a: 'wrong-shape' } } as never)).validate(), false);
  });

  await t.test('structural tag schemas do not duplicate nested descriptor issues', async () => {
    const { A } = await load('nested-issues', 'a.model.js');
    const validator = getValidator(new A({ value: { name: 'x' } }));
    assert.equal(await validator.validate(), false);
    assert.deepEqual(validator.issues.map((issue: { readonly code: string; readonly path: readonly (string | number)[] }) => ({ code: issue.code, path: issue.path })), [
      { code: 'tooSmall', path: ['value', 'name'] },
    ]);
  });

  await t.test('nested schema constraints collect referenced descriptors and project them', async () => {
    const { A } = await load('nested-contains', 'a.model.js');
    assert.equal(await getValidator(new A({ children: [{ name: 'ok' }] })).validate(), true);
    assert.equal(await getValidator(new A({ children: [{ name: 7 }] } as never)).validate(), false);
  });

  await t.test('union branch predicates stay attached to their checker constituent', async () => {
    const { A } = await load('union-branches', 'a.model.js');
    const predicates = await load('union-branches', 'predicates.js');
    assert.equal(await getValidator(new A({ value: 'text' })).validate(), true);
    assert.equal(predicates.stringCalls, 1);
    assert.equal(predicates.numberCalls, 0);
    assert.equal(await getValidator(new A({ value: 7 })).validate(), true);
    assert.equal(predicates.stringCalls, 1);
    assert.equal(predicates.numberCalls, 1);
  });

  await t.test('utility aliases preserve two distinct same-signature predicates and deduplicate an alias', async () => {
    const validators = generatedModelFiles(root).find((artifact) => artifact.path.endsWith('/models.validators.generated.ts'))?.content ?? '';
    assert.equal(validators.match(/^import \{ \w+ as v\d+ \} from "[^"]*utility-aliases\/predicates\.js";$/gm)?.length, 2);
    const { A } = await load('utility-aliases', 'a.model.js');
    const predicates = await load('utility-aliases', 'predicates.js');
    assert.equal(await getValidator(new A({ payload: { value: 'ok' } })).validate({ failFast: false }), true);
    assert.equal(predicates.firstCalls, 1, 'the same declaration is called once through its alias');
    assert.equal(predicates.secondCalls, 1, 'the distinct same-signature declaration is retained');
  });

  await t.test('generic aliases preserve concrete local model identity for nested conversion', async () => {
    const { Parent } = await load('generic-aliases', 'parent.model.js');
    const { Child } = await load('generic-aliases', 'child.model.js');
    const parent = modelCodec(Parent).fromWireFormat({ child: { value: { name: 'nested' } } });
    assert.ok(parent.child.value instanceof Child, 'generic nested model is constructed as the concrete local class');
    assert.deepEqual(modelCodec(parent).toWireFormat(parent), { child: { value: { name: 'nested' } } });
  });

  // protects: T-855 only the first data part of an intersection was kept beside a tag; T-864 a generic tag alias with an array base was not generated
  await t.test('an intersection keeps every data part beside a tag, and a generic tag alias with a compound base describes the instantiated type', async () => {
    const { A } = await load('compound-bases', 'a.model.js');
    const valid = { parts: { a: 's', b: 1 }, before: 'abc', after: 'abc', list: ['x'], page: { items: ['x'] }, legacy: 'abc', state: 'on' };
    const invalid = async (override: object): Promise<boolean> => await getValidator(new A({ ...valid, ...override })).validate();
    assert.deepEqual([
      await invalid({}),
      await invalid({ parts: { a: 's' } }),
      await invalid({ parts: { a: 's', b: 'bad' } }),
      await invalid({ before: 'ab' }),
      await invalid({ after: 'ab' }),
      await invalid({ list: [] }),
      await invalid({ list: [1] }),
      await invalid({ page: { items: [1] } }),
      await invalid({ legacy: 'ab' }),
      await invalid({ state: 'maybe' }),
    ], [true, false, false, false, false, false, false, false, false, false]);
  });

  // protects: T-953 a mapped type that drops a tag in its template kept the tag of the property it copies its declaration from
  await t.test('a mapped type takes its tags from its template, not from the property it maps over', async () => {
    const { A } = await load('mapped-templates', 'a.model.js');
    const valid = { dropped: {}, droppedOverIntersection: {}, keptThroughMappedTemplate: {}, plain: { a: 'ab' }, both: { a: 'ab' } };
    const accepted = async (override: object): Promise<boolean> => await getValidator(new A({ ...valid, ...override })).validate();
    assert.deepEqual([
      await accepted({}),
      await accepted({ dropped: { x_a: 'abcd' } }),
      await accepted({ droppedOverIntersection: { x_a: 'abcd', y_a: 'abcd' } }),
      await accepted({ keptThroughMappedTemplate: { x_a: 'abc' } }),
      await accepted({ keptThroughMappedTemplate: { x_a: 'abcd' } }),
      await accepted({ plain: { a: 'abcd' } }),
      await accepted({ both: { a: 'a' } }),
      await accepted({ both: { a: 'abcd' } }),
    ], [true, true, true, true, false, true, false, false]);
  });

  await t.test('recursive local IModel aliases remain concrete nested references', async () => {
    const { Node } = await load('recursive-alias', 'node.model.js');
    const node = modelCodec(Node).fromWireFormat({ name: 'root', children: [{ name: 'leaf' }] });
    assert.ok(node.children?.[0] instanceof Node);
    assert.deepEqual(modelCodec(node).toWireFormat(node), { name: 'root', children: [{ name: 'leaf' }] });
  });
});

for (const validation of [true, false] as const) {
  test(`malformed built-in tags are rejected before artifacts for validation=${validation}`, t => {
    const cases: readonly {
      readonly name: string;
      readonly imports: SourceFragment;
      readonly prefix?: SourceFragment;
      readonly field: SourceFragment;
      readonly bindings?: SourceFragment;
      readonly expected: RegExp;
    }[] = [
      {
        name: 'wrong direct family',
        imports: tsSource`import type { MinLength } from '@exprtlabs/golem/tags';`,
        field: tsSource`value: number & MinLength<3>`,
        expected: /RUNM1051: Constraint on the model value requires a string type/,
      },
      {
        name: 'schema-valued wrong direct family',
        imports: tsSource`import type { Contains } from '@exprtlabs/golem/tags';`,
        field: tsSource`value: string & Contains<string>`,
        expected: /RUNM1051: Constraint on the model value requires an? array type/,
      },
      {
        name: 'wrong family after a generic alias',
        imports: tsSource`import type { MinLength } from '@exprtlabs/golem/tags';`,
        prefix: tsSource`type Tagged<T> = T & MinLength<3>;`,
        field: tsSource`value: Tagged<number>`,
        expected: /RUNM1051: Constraint on the model value requires a string type/,
      },
      {
        name: 'invalid wire family',
        imports: tsSource`import type { MinLength, TSerde } from '@exprtlabs/golem/tags';`,
        field: tsSource`value: number & TSerde<typeof encode, typeof decode>`,
        bindings: tsSource`import type { MinLength } from '@exprtlabs/golem/tags';
export function encode(value: number): string { return String(value); }
export function decode(value: number & MinLength<3>): number { return value; }`,
        expected: /RUNM1051: Constraint on the wire value requires a string type/,
      },
      {
        // protects: T-555 a string format on a number still stops generation; only int32, int64, float and double apply to numbers
        name: 'string format on a number',
        imports: tsSource`import type { Format } from '@exprtlabs/golem/tags';`,
        field: tsSource`value: number & Format<'email'>`,
        expected: /RUNM1051: Constraint on the model value requires a string type/,
      },
      {
        // protects: T-555 a number format checks a number, so a string field cannot carry it unchecked
        name: 'number format on a string',
        imports: tsSource`import type { Format } from '@exprtlabs/golem/tags';`,
        field: tsSource`value: string & Format<'int32'>`,
        expected: /RUNM1051: Constraint on the model value requires a number type/,
      },
      {
        name: 'invalid minimum',
        imports: tsSource`import type { Minimum } from '@exprtlabs/golem/tags';`,
        field: tsSource`value: string & Minimum<10>`,
        expected: /RUNM1051: Constraint on the model value requires a number type/,
      },
      {
        name: 'negative length',
        imports: tsSource`import type { MinLength } from '@exprtlabs/golem/tags';`,
        field: tsSource`value: string & MinLength<-1>`,
        expected: /RUNM1043: MinLength requires a non-negative integer literal argument/,
      },
      {
        name: 'invalid Unicode pattern',
        imports: tsSource`import type { Pattern } from '@exprtlabs/golem/tags';`,
        field: tsSource`value: string & Pattern<'['>`,
        expected: /RUNM1044: Pattern requires a valid Unicode regular expression/,
      },
    ];
    for (const item of cases) {
      const { root, sourceRoot } = fixture(t);
      if (item.bindings) fs.writeFileSync(path.join(sourceRoot, 'bindings.ts'), item.bindings.text);
      const generated = path.join(sourceRoot, 'a.model.generated.ts');
      fs.writeFileSync(generated, '// existing generated output must survive a failed analysis\n');
      const imports = joinSource([
        item.imports,
        ...(item.bindings ? [tsSource`import { encode, decode } from './bindings.js';`] : []),
        ...(item.prefix ? [item.prefix] : []),
      ]);
      fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports, fields: item.field }).text);
      assert.throws(
        () => generate({ root, profile: { validation } }),
        error => {
          assert.match(String(error), item.expected, item.name);
          return true;
        },
        item.name,
      );
      assert.equal(fs.readFileSync(generated, 'utf8'), '// existing generated output must survive a failed analysis\n');
    }
  });
}

test('nullable and optional tagged branches retain their supported family', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { Format, MinItems, MinLength } from '@exprtlabs/golem/tags';`,
    fields: tsSource`required: (string & MinLength<3>) | null; optional?: string & Format<'domain-specific'>; values: (number[] & MinItems<1>) | undefined`,
  }).text);
  assert.doesNotThrow(() => generate({ root, profile: { validation: true } }));
});

test('a recursive type whose property name ends in a tag key name is a plain user type', t => {
  // protects: fixed bug (T-367): a property named notTag made isPhantomTagType read the user type as a tag and hid its cycle
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`type Chain = { notTag: string; next?: Chain };`,
    fields: tsSource`chain: Chain`,
  }).text);
  const shared = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.match(shared, /notTag/);
});

const typedRules = {
  'an annotated arrow': tsSource`export const check: (v: string) => boolean = (v) => v !== '';\nexport const other: (v: string) => boolean = (v) => v.length < 9;\nexport const write: (v: string) => string = (v) => v;\nexport const read: (w: string) => string = (w) => w;`,
  'a const typed by a type alias': tsSource`type Check = (v: string) => boolean;\ntype Write = (v: string) => string;\ntype Read = (w: string) => string;\nexport const check: Check = (v) => v !== '';\nexport const other: Check = (v) => v.length < 9;\nexport const write: Write = (v) => v;\nexport const read: Read = (w) => w;`,
  'consts that share one type alias': tsSource`type Fn = (v: string) => string;\ntype Ok = (v: string) => boolean;\nexport const check: Ok = (v) => v !== '';\nexport const other: Ok = (v) => v.length < 9;\nexport const write: Fn = (v) => v;\nexport const read: Fn = (v) => v;`,
} as const;

/** The import lines of the generated files that bring in `name` (as `name` or `name as vN`). */
function importsOf(generated: string, name: string): number {
  return (generated.match(new RegExp(`^import \\{[^}]*\\b${name}\\b(?: as \\w+)?[^}]*\\} from`, 'gm')) ?? []).length;
}

for (const [name, rules] of Object.entries(typedRules)) {
  test(`${name} is a TValidation and a TSerde function`, t => {
    // protects: F-31 a typed const named by typeof is a valid tag function (T-430, was RUNM1040)
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), rules.text);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
      name: 'A',
      imports: tsSource`import type { TSerde, TValidation } from '@exprtlabs/golem/tags';\nimport { check, other, read, write } from './rules.js';`,
      fields: tsSource`valid: string & TValidation<typeof check>; second: string & TValidation<typeof other>; coded: string & TSerde<typeof write, typeof read>`,
    }).text);
    const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
    for (const bound of ['check', 'other', 'write', 'read']) assert.ok(importsOf(generated, bound) > 0, `${bound} is bound`);
  });
}

test('two validators that share one type alias in one field are refused, not bound by guess', t => {
  // protects: F-31 a function the checker cannot name from its type is not guessed from a shared alias (T-430)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), typedRules['consts that share one type alias'].text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { check, other } from './rules.js';`,
    fields: tsSource`both: string & TValidation<typeof check> & TValidation<typeof other>`,
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1040.*shares its type with another function in this field/);
});

const throughNonNullable = tsSource`type Box = { a: (string & TValidation<typeof check>) | null };\ntype Field = { [K in keyof Box]: NonNullable<Box[K]> };`;

const ownAnnotations = {
  plain: typedRules['an annotated arrow'],
  parenthesized: tsSource`export const check: ((v: string) => boolean) = (v) => v !== '';`,
  'a type alias': typedRules['a const typed by a type alias'],
} as const;

for (const [form, rules] of Object.entries(ownAnnotations)) test(`a validator const with its own ${form} function type annotation is bound through a NonNullable mapped type`, t => {
  // protects: T-957 the tag read from the mapped type named no function and threw RUNM1040 (F-31 TypeScript is the schema)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), rules.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { check } from './rules.js';\n${throughNonNullable}`,
    fields: tsSource`field: Field`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.ok(importsOf(generated, 'check') > 0, 'check is bound');
  assert.equal(importsOf(generated, 'other'), 0, 'the const that shares its type is not bound');
});

// `b` copies the type of `a`, so the checker shows one type for both: only the source node names the function that was written.
const copiedFunctionRules = {
  inline: tsSource`export const a: (v: string) => boolean = (v) => v !== '';\nexport const b: typeof a = (v) => v.length < 9;`,
  inferred: tsSource`export const a = (v: string): boolean => v !== '';\nexport const b: typeof a = (v) => v.length < 9;`,
} as const;
const throughMapped = tsSource`type Box = { f: (string & TValidation<typeof b>) | null };\ntype Field = { [K in keyof Box]: NonNullable<Box[K]> };`;
const copiedFunctionReads = {
  'inline a on the field': { rules: copiedFunctionRules.inline, declarations: tsSource``, field: tsSource`string & TValidation<typeof b>` },
  'inline a through a NonNullable mapped type': { rules: copiedFunctionRules.inline, declarations: throughMapped, field: tsSource`Field` },
  'inferred a through a NonNullable mapped type': { rules: copiedFunctionRules.inferred, declarations: throughMapped, field: tsSource`Field` },
  'inline a as an alias type argument': { rules: copiedFunctionRules.inline, declarations: tsSource`type Same<T> = T;`, field: tsSource`Same<string & TValidation<typeof b>>` },
  'inferred a as an alias type argument': { rules: copiedFunctionRules.inferred, declarations: tsSource`type Same<T> = T;`, field: tsSource`Same<string & TValidation<typeof b>>` },
  'inline a through a conditional type': { rules: copiedFunctionRules.inline, declarations: tsSource`type Box = { f: string & TValidation<typeof b> };\ntype ValueOf<T> = T extends { f: infer V } ? V : never;`, field: tsSource`ValueOf<Box>` },
  'inline a through the type of a variable': { rules: copiedFunctionRules.inline, declarations: tsSource`declare const held: string & TValidation<typeof b>;`, field: tsSource`typeof held` },
} as const;

for (const [name, read] of Object.entries(copiedFunctionReads)) test(`a validator that copies the type of another binds itself, read as ${name}`, t => {
  // protects: T-982 the tag read from the checker type named the function that owns the type, so `b` bound `a` in silence (F-31 TypeScript is the schema)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), read.rules.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { b } from './rules.js';\n${read.declarations}`,
    fields: tsSource`field: ${read.field}`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.equal(importsOf(generated, 'b'), 1, 'b is bound');
  assert.equal(importsOf(generated, 'a'), 0, 'a is not bound');
});

test('a serializer that copies the type of another binds itself through a NonNullable mapped type', t => {
  // protects: T-982 same cause as the validator: the TSerde read from the checker type named the function that owns the type
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), tsSource`export const write: (v: string) => string = (v) => v;\nexport const copy: typeof write = (v) => v.trim();\nexport const read: (w: string) => string = (w) => w;`.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';\nimport { copy, read } from './rules.js';\ntype Box = { f: (string & TSerde<typeof copy, typeof read>) | null };\ntype Field = { [K in keyof Box]: NonNullable<Box[K]> };`,
    fields: tsSource`field: Field`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.equal(importsOf(generated, 'copy'), 1, 'copy is bound');
  assert.equal(importsOf(generated, 'write'), 0, 'write is not bound');
});

test('a validator that copies the type of another binds itself when a declaration file writes the tag', t => {
  // protects: T-982 the scan skipped every declaration file, so a tag written in a .d.ts reached the field with no `typeof` and was refused (R-55 no silent difference)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'defs.d.ts'), tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport type { b } from './rules.js';\nexport type Email = string & TValidation<typeof b>;\nexport type Box = { f: Email | null };`.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { Box } from './defs.js';\ntype Field = { [K in keyof Box]: NonNullable<Box[K]> };`,
    fields: tsSource`field: Field`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.equal(importsOf(generated, 'b'), 1, 'b is bound');
  assert.equal(importsOf(generated, 'a'), 0, 'a is not bound');
});

// `a` and `b` share one type, and a base class or interface writes `typeof a` where the field writes `typeof b`: the scan follows the base.
// `ValueOf` reads the member through a conditional type, so no property symbol leads to the base and only the `extends` clause does.
const valueOf = tsSource`type ValueOf<T> = T extends { held: infer V } ? V : never;`;
const inheritedTagReads = {
  'a base class': tsSource`${valueOf}\nclass Base { held!: string & TValidation<typeof a>; }\nclass Sub extends Base {}`,
  'a base interface': tsSource`${valueOf}\ninterface Base { held: string & TValidation<typeof a>; }\ninterface Sub extends Base {}`,
} as const;

for (const [name, declarations] of Object.entries(inheritedTagReads)) test(`a copy written on the field beside a function that ${name} writes is refused`, t => {
  // protects: T-1019 the scan did not follow an `extends` clause, so the base function was dropped and the copy bound in silence (R-55 no silent difference)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\n${declarations}`,
    fields: tsSource`field: ValueOf<Sub> & TValidation<typeof b>`,
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1040.*shares its type with another function in this field/);
});

test('a copy written on the field beside a function that a mixin base writes is refused', t => {
  // protects: T-1019 a class that extends a call has no base to follow, so the function of its member was dropped and the copy bound in silence (R-55 no silent difference)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\nclass Base { held!: string & TValidation<typeof a>; }\ndeclare function mixin<T extends new () => object>(base: T): T;\nclass Sub extends mixin(Base) {}`,
    fields: tsSource`field: Sub['held'] & TValidation<typeof b>`,
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1040.*shares its type with another function in this field/);
});

// `a` and `b` share one type, and `Box['f']` writes `typeof a` where the tag of the field writes `typeof b`: golem cannot bind both by their type.
const hiddenCopyReads = {
  'an indexed access beside the tag of the field': tsSource`Box['f'] & TValidation<typeof b>`,
  'an object field beside the tag of the field': tsSource`{ inner: Box['f'] } & TValidation<typeof b>`,
} as const;

for (const [name, field] of Object.entries(hiddenCopyReads)) test(`a validator and the validator that it copies are refused when ${name} writes the other`, t => {
  // protects: T-982 the scan found one function for the type and the other one dropped, with no error (R-55 no silent difference)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), tsSource`export const a: (v: unknown) => boolean = (v) => v !== '';\nexport const b: typeof a = (v) => v !== 0;`.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\ntype Box = { f: string & TValidation<typeof a> };`,
    fields: tsSource`field: ${field}`,
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1040.*shares its type with another function in this field/);
});

test('a tag function that comes from an inferred type is refused, not bound by its type', t => {
  // protects: T-982 no `typeof` in the field leads to the function that the inferred type names
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { b } from './rules.js';\ndeclare function tagged(): string & TValidation<typeof b>;\nconst held = tagged();`,
    fields: tsSource`field: typeof held`,
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1040.*cannot read back to the `typeof` that wrote it/);
});

// `held` carries `typeof a` through an inferred type, and the field writes its copy `b`: the checker shows one tag for both, and the source holds only `typeof b`.
const inferredTagReads = {
  'a const inferred from a call': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nconst held = tagged();`, field: tsSource`typeof held & TValidation<typeof b>` },
  'the inferred return of a function': { declarations: tsSource`declare const source: string & TValidation<typeof a>;\nfunction tagged() { return source; }`, field: tsSource`ReturnType<typeof tagged> & TValidation<typeof b>` },
  'an inferred class member': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nclass Holder { held = tagged(); }`, field: tsSource`Holder['held'] & TValidation<typeof b>` },
  'the return of an arrow function': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nconst make = () => tagged();`, field: tsSource`ReturnType<typeof make> & TValidation<typeof b>` },
  'a property of an inferred object': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nconst holder = { held: tagged() };`, field: tsSource`(typeof holder)['held'] & TValidation<typeof b>` },
  'a class getter': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nclass Holder { get held() { return tagged(); } }`, field: tsSource`Holder['held'] & TValidation<typeof b>` },
  'a promise of the tagged value': { declarations: tsSource`declare function tagged(): Promise<string & TValidation<typeof a>>;\nconst held = tagged();`, field: tsSource`Awaited<typeof held> & TValidation<typeof b>` },
  'a frozen object': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nconst holder = Object.freeze({ held: tagged() });`, field: tsSource`(typeof holder)['held'] & TValidation<typeof b>` },
  'a conditional type over a class with an inferred member': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nclass Holder { held = tagged(); }\ntype ValueOf<T> = T extends { held: infer V } ? V : never;`, field: tsSource`ValueOf<Holder> & TValidation<typeof b>` },
  'an as-mapped type over a class with an inferred member': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nclass Holder { held = tagged(); }\ntype Renamed<T> = { [K in keyof T as Uppercase<K & string>]: T[K] };`, field: tsSource`Renamed<Holder>['HELD'] & TValidation<typeof b>` },
  'a conditional type over a class that extends a mixin call': { declarations: tsSource`class Base { held!: string & TValidation<typeof a>; }\ndeclare function mixin<T extends new () => object>(base: T): T;\nclass Sub extends mixin(Base) {}\ntype ValueOf<T> = T extends { held: infer V } ? V : never;`, field: tsSource`ValueOf<Sub> & TValidation<typeof b>` },
  'a destructured const': { declarations: tsSource`declare function tagged(): string & TValidation<typeof a>;\nconst holder = { held: tagged() };\nconst { held } = holder;`, field: tsSource`typeof held & TValidation<typeof b>` },
} as const;

for (const [name, read] of Object.entries(inferredTagReads)) test(`a copy written on the field beside a function that only an inferred type holds is refused, read as ${name}`, t => {
  // protects: T-1019 the scan found only the copy `b` for the shared type, so the validator that `held` carries was dropped and `b` bound in silence (R-55 no silent difference)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\n${read.declarations}`,
    fields: tsSource`field: ${read.field}`,
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1040.*through `[^`]+` \(\S*a\.model\.ts:\d+:\d+\), whose type golem infers/);
});

// Nothing in these reads holds a function tag that the field could lose, so the copy `b` binds.
const untaggedReads = {
  'a conditional type over a class with an untagged inferred member': { declarations: tsSource`class Holder { held = ''; }\ntype ValueOf<T> = T extends { held: infer V } ? V : never;`, field: tsSource`ValueOf<Holder>` },
  'a conditional type over a class that extends an untagged mixin call': { declarations: tsSource`class Base { held = ''; }\ndeclare function mixin<T extends new () => object>(base: T): T;\nclass Sub extends mixin(Base) {}\ntype ValueOf<T> = T extends { held: infer V } ? V : never;`, field: tsSource`ValueOf<Sub>` },
} as const;

for (const [name, { declarations, field }] of Object.entries(untaggedReads)) test(`the tag of the field binds its own function through ${name}`, t => {
  // protects: T-1043 a refusal of every conditional type over an inferred member or a mixin call would stop fields that lose no tag
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { b } from './rules.js';\n${declarations}`,
    fields: tsSource`field: ${field} & TValidation<typeof b>`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.equal(importsOf(generated, 'b'), 1, 'b is bound');
});

// `Wrap<T>` hands the tag `c` to the checker alone, so the field is scanned for the function that `c` names; the scan must leave the sibling members `f` and `g` to their own fields.
test('two members that copy each other\'s function type each bind their own function beside a tag that only the checker shows', t => {
  // protects: T-1043 the registry of the field kept every function that its scan found, so `f` and `g` inherited a type shared by two functions and were refused
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), tsSource`${copiedFunctionRules.inline}\nexport const c: (v: unknown) => boolean = (v) => v !== null;`.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b, c } from './rules.js';\ntype Box = { f: string & TValidation<typeof a>; g: string & TValidation<typeof b> };\ntype Wrap<T> = T;`,
    fields: tsSource`field: Wrap<Box & TValidation<typeof c>>`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  for (const bound of ['a', 'b', 'c']) assert.equal(importsOf(generated, bound), 1, `${bound} is bound`);
});

// `a` and `b` share one type and `User` writes `typeof b` on `name`: a sibling member that holds the tag through an inferred type is not read, so it must not stop the build.
const userWith = (member: SourceFragment): SourceFragment => tsSource`class User { name!: string & TValidation<typeof b>; ${member} }`;
// `Sub` inherits `name` from `Base`, so the getter and the tagged member sit in two classes.
const inheritedUser = tsSource`class Base { name!: string & TValidation<typeof b>; }\nclass Sub extends Base { get label() { return this.name; } }`;
const sameTypeNeighbours = {
  'an indexed access beside a getter that returns the tagged member': { declarations: userWith(tsSource`get label() { return this.name; }`), field: tsSource`User['name']` },
  'Pick beside a getter that returns the tagged member': { declarations: userWith(tsSource`get label() { return this.name; }`), field: tsSource`Pick<User, 'name'>['name']` },
  'Omit beside a getter that returns the tagged member': { declarations: userWith(tsSource`get label() { return this.name; }`), field: tsSource`Omit<User, 'label'>['name']` },
  'Pick beside a member that holds no tag': { declarations: userWith(tsSource`count = 0;`), field: tsSource`Pick<User, 'name'>['name']` },
  'Omit of a subclass getter': { declarations: inheritedUser, field: tsSource`Omit<Sub, 'label'>['name']` },
  'Pick of a subclass getter': { declarations: inheritedUser, field: tsSource`Pick<Sub, 'name'>['name']` },
  'Readonly Pick of a subclass getter': { declarations: inheritedUser, field: tsSource`Readonly<Pick<Sub, 'name'>>` },
} as const;

for (const [name, { declarations, field }] of Object.entries(sameTypeNeighbours)) test(`the tag of a member binds its own function, read through ${name}`, t => {
  // protects: T-1019 the first fix refused a field that read `name` of a class with an inferred sibling, though the sibling is not part of the field (F-37 no false refusal)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\n${declarations}`,
    fields: tsSource`field: ${field}`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.equal(importsOf(generated, 'b'), 1, 'b is bound');
  assert.equal(importsOf(generated, 'a'), 0, 'a is not bound');
});

// `a` and `b` share one type. Each read names a function through a wrapper, a Pick that is no alias argument, or an inferred getter beside a Pick.
const wrapperReads = {
  'a wrapper whose tag copies the type of the function that its argument writes': { declarations: tsSource`type Box = { f: string & TValidation<typeof a> };\ntype Wrap<T extends { f: unknown }> = { x: T['f'] & TValidation<typeof b> };`, field: tsSource`Wrap<Box>`, refused: true },
  'a wrapper that indexes its argument': { declarations: tsSource`class Plain { name!: string & TValidation<typeof b>; }\ntype Wrap<T extends { name: unknown }> = { x: T['name'] };`, field: tsSource`Wrap<Plain>['x']`, refused: false },
  'an alias of a Pick that is read by an index': { declarations: tsSource`${inheritedUser}\ntype Named = Pick<Sub, 'name'>;`, field: tsSource`Named['name']`, refused: false },
  'a Pick beside a member that reads an inferred getter of the other function': { declarations: tsSource`declare const other: string & TValidation<typeof a>;\nclass Base { name!: string & TValidation<typeof b>; }\nclass Sub extends Base { get label() { return other; } }`, field: tsSource`Pick<Sub, 'name'> & { extra: Sub['label'] }`, refused: true },
} as const;

for (const [name, { declarations, field, refused }] of Object.entries(wrapperReads)) test(`${refused ? 'a function that hides behind' : 'the tag of the field binds its own function through'} ${name}${refused ? ' is refused' : ''}`, t => {
  // protects: T-1043 the first fix of the sibling rule bound `b` for the wrapper in silence, and refused the others that built before it
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\n${declarations}`,
    fields: tsSource`field: ${field}`,
  }).text);
  if (refused) {
    assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1040/);
    return;
  }
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.equal(importsOf(generated, 'b'), 1, 'b is bound');
  assert.equal(importsOf(generated, 'a'), 0, 'a is not bound');
});

// `f` writes `typeof a` and `g` writes `typeof b`, and `b` copies the type of `a`: each member binds the function that it writes.
const siblingBox = tsSource`type Box = { f: (string & TValidation<typeof a>) | null; g: (string & TValidation<typeof b>) | null };`;
const siblingReads = {
  'a NonNullable mapped type': { declarations: tsSource`${siblingBox}\ntype Field = { [K in keyof Box]: NonNullable<Box[K]> };`, field: tsSource`Field` },
  'the type itself': { declarations: siblingBox, field: tsSource`Box` },
  'the type or null': { declarations: siblingBox, field: tsSource`Box | null` },
  'two indexed members of the type': { declarations: siblingBox, field: tsSource`{ x: Box['g']; y: Box['f'] }` },
} as const;

for (const [name, { declarations, field }] of Object.entries(siblingReads)) test(`two members that copy each other's function type each bind their own function, read as ${name}`, t => {
  // protects: T-1020, T-1031 the scan of the enclosing type, or of `Box` under `Box['g']`, read every member of `Box` for each member, so `f` and `g` shared one type with two functions and were refused (F-37 no false refusal)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), copiedFunctionRules.inline.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b } from './rules.js';\n${declarations}`,
    fields: tsSource`field: ${field}`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.equal(importsOf(generated, 'a'), 1, 'a is bound');
  assert.equal(importsOf(generated, 'b'), 1, 'b is bound');
});

// A getter that holds the tag through an inferred type, or an inferred value of another function type, sits in the reach of the field and adds no tag to its type.
const unreadInferredTags = {
  'a mapped NonNullable over a member that sits beside an inferred getter': {
    declarations: tsSource`class User { name!: string & TValidation<typeof b>; get label() { return this.name; } }\ntype Box = { f: User['name'] | null };\ntype Field = { [K in keyof Box]: NonNullable<Box[K]> };`,
    field: tsSource`Field`,
  },
  'an inferred value of another function type that the type of the field drops': {
    declarations: tsSource`declare function tagged(): string & TValidation<typeof d>;\nconst held = tagged();\ntype Plain<T> = T extends string ? string : never;`,
    field: tsSource`Plain<typeof held> & TValidation<typeof b>`,
  },
} as const;

for (const [name, { declarations, field }] of Object.entries(unreadInferredTags)) test(`the tag of the field binds its own function through ${name}`, t => {
  // protects: T-1019 the second fix refused a field when any inferred tag sat in its reach, though that tag is not in its type (F-37 no false refusal)
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), tsSource`${copiedFunctionRules.inline}\nexport const d: (v: unknown) => boolean = (v) => v !== null;`.text);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { a, b, d } from './rules.js';\n${declarations}`,
    fields: tsSource`field: ${field}`,
  }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
  assert.equal(importsOf(generated, 'b'), 1, 'b is bound');
  assert.equal(importsOf(generated, 'a'), 0, 'a is not bound');
});

test('a nullable member written through a tag alias is refused, not given a phantom-key validator', t => {
  // protects: fixed bug (T-430): at 75548ea this generated a validator that rejected every plain string
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { MaxLength } from '@exprtlabs/golem/tags';\ntype Inner<N extends number> = MaxLength<N>;`,
    fields: tsSource`name: Inner<5> & string | null`,
  }).text);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1064/);
});

for (const [form, field] of [['optional', tsSource`email?: string & TValidation<typeof check>`], ['nullable', tsSource`email: (string & TValidation<typeof check>) | null`]] as const) {
  test(`a ${form} field with a typed const validator binds it`, t => {
    // protects: F-31 an optional or nullable tagged field reads its tag from the authored member (T-430)
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), typedRules['an annotated arrow'].text);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
      name: 'A',
      imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { check } from './rules.js';`,
      fields: field,
    }).text);
    const generated = generate({ root, profile: { validation: true } }).artifacts.map((artifact) => artifact.content).join('\n');
    assert.ok(importsOf(generated, 'check') > 0, 'check is bound');
  });
}

test('a MobX model generated with validation false has no validator', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    fields: tsSource`title: string; done: boolean`,
  }).text);
  await buildModelProjectWith(root, { mobx: true, validation: false });
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const model = modelCodec(A).fromWireFormat({ title: 'Write', done: false });
  assert.equal('$validator' in model, false);
  assert.deepEqual(modelCodec(model).toWireFormat(model), { title: 'Write', done: false });
});

test('model validators are a generated TypeScript artifact that the built output runs', async t => {
  const { root, sourceRoot } = fixture(t);
  copyFixtureFile(
    root,
    'models/model-tags/standalone-model-validators-are-external-generated-artifacts-with-declarations-and-notices/predicates.ts',
    'src/predicates.ts',
  );
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    imports: tsSource`import type { TValidation } from '@exprtlabs/golem/tags';\nimport { valid } from './predicates.js';`,
    fields: tsSource`value: string & TValidation<typeof valid>`,
  }).text);
  await buildModelProjectWith(root, { validation: true });
  const artifacts = generatedModelFiles(root);
  const validators = artifacts.find((artifact) => artifact.path.endsWith('/models.validators.generated.ts'));
  assert.ok(validators);
  assert.ok(fs.existsSync(path.join(root, 'build', path.relative(sourceRoot, validators.path).replace(/\.ts$/, '.js'))), 'the build writes the validators');
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  assert.equal(await getValidator(new A({ value: 'ok' })).validate(), true);
  assert.equal(await getValidator(new A({ value: 'bad' })).validate(), false);
});

test('constraint and predicate tag order does not change the generated files or the codec id', t => {
  const generated = (type: SourceFragment) => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'rules.ts'), `export function notBlank(value: string): boolean { return value.trim() !== ''; }
export function noDigits(value: string): boolean | string { return !/\\d/.test(value) || 'digits'; }
`);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
      name: 'A',
      imports: tsSource`import type { MaxLength, MinLength, Pattern, TValidation } from '@exprtlabs/golem/tags';\nimport { notBlank, noDigits } from './rules.js';`,
      fields: tsSource`value: ${type}`,
    }).text);
    return generate({ root, profile: { validation: true } }).artifacts
      .map(artifact => [path.relative(root, artifact.path), artifact.content] as const)
      .sort(([left], [right]) => left.localeCompare(right));
  };
  const forward = generated(tsSource`string & MinLength<2> & MaxLength<4> & Pattern<'^[a-z0-9 ]+$'> & TValidation<typeof notBlank> & TValidation<typeof noDigits>`);
  const constraintsReordered = generated(tsSource`string & Pattern<'^[a-z0-9 ]+$'> & TValidation<typeof notBlank> & MaxLength<4> & TValidation<typeof noDigits> & MinLength<2>`);
  assert.deepEqual(constraintsReordered, forward);
  // Predicates run in a fixed order too: types that differ only in predicate order share a codec id, so they must
  // also share the generated bindings, whichever is generated first.
  const predicatesReordered = generated(tsSource`string & MinLength<2> & MaxLength<4> & Pattern<'^[a-z0-9 ]+$'> & TValidation<typeof noDigits> & TValidation<typeof notBlank>`);
  assert.deepEqual(predicatesReordered, forward);
});

for (const item of [
  { name: 'a module interface named Date keeps its own fields', declaration: tsSource`interface Date { label: string }`, wire: { when: { label: 'launch' } }, isDate: false },
  { name: 'a global augmentation of Date keeps it a date', declaration: tsSource`declare global { interface Date { toUnix(): number } }`, wire: { when: '2025-01-02T03:04:05.000Z' }, isDate: true },
  { name: 'the global Date is a date', declaration: tsSource``, wire: { when: '2025-01-02T03:04:05.000Z' }, isDate: true },
] as const) {
  test(`${item.name}`, async t => {
    // protects: F-31 only the global Date is read as a date; a user type named Date keeps its shape
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: item.declaration, fields: tsSource`when: Date` }).text);
    await buildModelProjectWith(root, { validation: true });
    const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
    const model = modelCodec(A).fromWireFormat(item.wire);
    assert.equal(model.when instanceof Date, item.isDate);
    assert.deepEqual(modelCodec(model).toWireFormat(model), item.wire);
  });
}
