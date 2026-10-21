import { copyFixture, copyFixtureFile, readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generatedJsonData } from './generated-data.js';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { getValidator } from '@exprtlabs/golem/validation';
import { tagsProject as fixture } from './support/model-tags-project.js';
import { buildModelProject, generatedModelFiles, writeModelGolemYaml } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { joinSource, tsSource, type SourceFragment } from './source-template.js';
import { generate } from '#model/generator';

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
  writeModelGolemYaml(first.root, { mobx: false, validation: true });
  await buildModelProject(first.root);
  const firstArtifacts = generatedModelFiles(first.root);
  const firstShared = firstArtifacts.filter((artifact) => artifact.path.endsWith('.model.generated.ts')).map((artifact) => artifact.content).join('\n');
  assert.ok(firstShared);
  assert.doesNotMatch(firstShared, new RegExp(first.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const firstValidators = firstArtifacts.find((artifact) => artifact.path.endsWith('/models.validators.generated.ts'))?.content ?? '';
  assert.doesNotMatch(firstValidators, new RegExp(first.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((firstValidators.match(/^import \{ \w+ as v\d+ \} from /gm) ?? []).length, 2, 'same-signature functions from separate declarations remain distinct');

  const second = fixture(t);
  build(second.sourceRoot);
  const secondResult = generate({ root: second.root, profile: { mobx: false, validation: true } });
  const firstByRelative = new Map(firstArtifacts.map(artifact => [path.relative(first.root, artifact.path), artifact.content]));
  for (const artifact of secondResult.artifacts) {
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
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const shared = generatedModelFiles(root).map((artifact) => artifact.content).join('\n');
  for (const keyword of [
    'contains', 'minContains', 'maxContains', 'minProperties', 'maxProperties',
    'propertyNames', 'patternProperties', 'additionalProperties', 'unevaluatedProperties',
    'dependentRequired', 'dependentSchemas', 'oneOf', 'not', 'if', 'then', 'else',
  ]) assert.match(shared, new RegExp(`\\b${keyword}\\b`), keyword);
  assert.match(generatedJsonData(shared), /"contains"[\s\S]*"(?:minContains"[\s\S]*"maxContains|maxContains"[\s\S]*"minContains)/);
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
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
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
    const shared = generatedModelFiles(root).map((artifact) => artifact.content).join('\n');
    assert.match(generatedJsonData(shared), /"contains"/);
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
    const parent = decodeGeneratedModel(Parent, { child: { value: { name: 'nested' } } });
    assert.ok(parent.child.value instanceof Child, 'generic nested model is constructed as the concrete local class');
    assert.deepEqual(encodeGeneratedModel(parent), { child: { value: { name: 'nested' } } });
  });

  await t.test('recursive local IModel aliases remain concrete nested references', async () => {
    const { Node } = await load('recursive-alias', 'node.model.js');
    const node = decodeGeneratedModel(Node, { name: 'root', children: [{ name: 'leaf' }] });
    assert.ok(node.children?.[0] instanceof Node);
    assert.deepEqual(encodeGeneratedModel(node), { name: 'root', children: [{ name: 'leaf' }] });
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
        () => generate({ root, profile: { mobx: false, validation } }),
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
  assert.doesNotThrow(() => generate({ root, profile: { mobx: false, validation: true } }));
});

test('a MobX model generated with validation false has no validator', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({
    name: 'A',
    fields: tsSource`title: string; done: boolean`,
  }).text);
  writeModelGolemYaml(root, { mobx: true, validation: false });
  await buildModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const model = decodeGeneratedModel(A, { title: 'Write', done: false });
  assert.equal('$validator' in model, false);
  assert.deepEqual(encodeGeneratedModel(model), { title: 'Write', done: false });
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
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
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
    return generate({ root, profile: { mobx: false, validation: true } }).artifacts
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
  { name: 'the global Date is a date', declaration: tsSource``, wire: { when: '2025-01-02T03:04:05.000Z' }, isDate: true },
] as const) {
  test(`${item.name}`, async t => {
    // protects: F-31 only the global Date is read as a date; a user type named Date keeps its shape
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: item.declaration, fields: tsSource`when: Date` }).text);
    writeModelGolemYaml(root, { mobx: false, validation: true });
    await buildModelProject(root);
    const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
    const model = decodeGeneratedModel(A, item.wire);
    assert.equal(model.when instanceof Date, item.isDate);
    assert.deepEqual(encodeGeneratedModel(model), item.wire);
  });
}
