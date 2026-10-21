import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { IssueRepresentation, IssueSource, LibError, LibErrorKind, type Issue } from '@exprtlabs/golem/errors';
import { getValidator } from '@exprtlabs/golem/validation';
import type { GolemProfile } from '#golem/generator-api';
import { generate } from '#model/generator';
import { buildModelProject, writeModelGolemYaml } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { readFixture } from './fixture-project.js';
import { modelAliasSource, referencedPolicyModelSource, taggedProfilePayloadSource } from './fixture-templates/models/profile-options.js';
import { identifier, tsSource, type SourceFragment } from './source-template.js';

function profile(overrides: Partial<GolemProfile> = {}): GolemProfile {
  return {
    mobx: false,
    validation: true,
    allowAny: false,
    ...overrides,
  };
}

function modelProject(t: TestContext): { root: string; sourceRoot: string; source: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-profile-model-')));
  const sourceRoot = path.join(root, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  fs.symlinkSync(
    path.join(process.cwd(), 'packages/golem'),
    path.join(root, 'node_modules/@exprtlabs/golem'),
    'dir',
  );
  fs.symlinkSync(path.join(process.cwd(), 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'dir');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      skipLibCheck: true,
      outDir: 'build',
      rootDir: 'src',
    },
    include: ['src/**/*.ts'],
  }));
  const source = path.join(sourceRoot, 'payload.model.ts');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sourceRoot, source };
}

function writeModel(source: string, declaration: SourceFragment): void {
  fs.writeFileSync(source, modelAliasSource({ declaration }).text);
}

async function compileModel(root: string): Promise<void> {
  await buildModelProject(root);
}

function assertModelArtifactRoles(
  root: string,
  source: string,
  result: { readonly artifacts: readonly { readonly path: string; readonly content: string }[] },
  validation: boolean,
): void {
  const companionPath = source.replace(/\.model\.ts$/, '.model.generated.ts');
  const companion = result.artifacts.find(artifact => artifact.path === companionPath);
  assert.ok(companion, `generated companion artifact ${companionPath}`);
  assert.match(companion.content, /registerGeneratedModel/);

  const validatorsPath = path.join(root, 'src/generated/models/models.validators.generated.ts');
  if (validation) {
    assert.match(companion.content, /createObjectCodec|validatePayload/);
  }

  // The provider is pure: artifact discovery must not write either generated role.
  assert.equal(fs.existsSync(companionPath), false);
  assert.equal(fs.existsSync(validatorsPath), false);
}

for (const type of ['any', 'unknown'] as const) {
  // The check of `unknown` does not depend on validation, so only `any` runs with it off.
  for (const validation of type === 'any' ? [true, false] as const : [true] as const) {
    test(`global allowAny applies to ${type} when validation=${validation}`, (t: TestContext) => {
      const { root, source } = modelProject(t);
      writeModel(source, tsSource`IModel<{ payload: ${identifier(type)} }>`);
      assert.throws(
        () => generate({ root, sources: [source], profile: profile({ validation }) }),
        /RUNM1011.*allowAny/,
      );

      const allowed = generate({
        root,
        sources: [source],
        profile: profile({ validation, allowAny: true }),
      });
      assertModelArtifactRoles(root, source, allowed, validation);
    });

    test(`per-model allowAny=true opts in and false tightens the global policy for ${type} when validation=${validation}`, (t: TestContext) => {
      const optedIn = modelProject(t);
      writeModel(optedIn.source, tsSource`IModel<{ payload: ${identifier(type)} }, { allowAny: true }>`);
      const optedInResult = generate({
        root: optedIn.root,
        sources: [optedIn.source],
        profile: profile({ validation }),
      });
      assertModelArtifactRoles(optedIn.root, optedIn.source, optedInResult, validation);

      const tightened = modelProject(t);
      writeModel(tightened.source, tsSource`IModel<{ payload: ${identifier(type)} }, { allowAny: false }>`);
      assert.throws(
        () => generate({
          root: tightened.root,
          sources: [tightened.source],
          profile: profile({ validation, allowAny: true }),
        }),
        /RUNM1011.*allowAny/,
      );
    });
  }
}

for (const item of [
  { position: 'an array item', declaration: tsSource`IModel<{ payload: unknown[] }>` },
  { position: 'a record value', declaration: tsSource`IModel<{ payload: Record<string, unknown> }>` },
  { position: 'a tuple item', declaration: tsSource`IModel<{ payload: [string, unknown] }>` },
] as const) {
  test(`a default model rejects unknown as ${item.position} with RUNM1011`, (t: TestContext) => {
    const { root, source } = modelProject(t);
    writeModel(source, item.declaration);
    assert.throws(() => generate({ root, sources: [source], profile: profile() }), /RUNM1011.*contains unknown/);
  });
}

test('a tagged unknown field is rejected by default and allowed by allowAny, as a tagged any is', (t: TestContext) => {
  const { root, source } = modelProject(t);
  fs.writeFileSync(source, tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { Format } from '@exprtlabs/golem/tags';
export type TPayload = IModel<{ opaque: unknown & Format<'domain-specific'> }>;
`.text);
  assert.throws(() => generate({ root, sources: [source], profile: profile() }), /RUNM1011.*contains unknown/);
  assertModelArtifactRoles(root, source, generate({ root, sources: [source], profile: profile({ allowAny: true }) }), true);
});

test('a pick of a member its source type lacks is not advised as allowAny, and a picked member really typed unknown still is', (t: TestContext) => {
  // protects: T-211 RUNM1011 points to allowAny only for a field typed any or unknown (F-176)
  const { root, source } = modelProject(t);
  const picked = (key: string): string => `import type { IModel } from '@exprtlabs/golem/model';
interface Source { a: string; loose: unknown }
export type TPayload = IModel<{ view: Pick<Source, '${key}'> }>;
`;
  fs.writeFileSync(source, picked('b'));
  assert.throws(() => generate({ root, sources: [source], profile: profile() }), (error: unknown) => {
    assert.match(String(error), /Field "b" is picked from Source, which has no member "b"/);
    assert.doesNotMatch(String(error), /allowAny/);
    return true;
  });
  fs.writeFileSync(source, picked('loose'));
  assert.throws(() => generate({ root, sources: [source], profile: profile() }), /RUNM1011.*contains unknown.*allowAny/);
});

test('a tag argument typed unknown passes by default, and a tag argument typed any is still rejected', (t: TestContext) => {
  const { root, source } = modelProject(t);
  const tagged = (argument: string): string => tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { Not } from '@exprtlabs/golem/tags';
export type TPayload = IModel<{ value: string & Not<${identifier(argument)}> }>;
`.text;
  fs.writeFileSync(source, tagged('unknown'));
  assertModelArtifactRoles(root, source, generate({ root, sources: [source], profile: profile() }), true);
  fs.writeFileSync(source, tagged('any'));
  assert.throws(() => generate({ root, sources: [source], profile: profile() }), /RUNM1011.*contains any/);
});

/** Builds a project of `TOpen` (no `exact` option) and `TClosed` (`exact: true`) whose golem.yaml sets the root `exact` default, and gives each model's codec check. */
async function buildExactModels(t: TestContext, exact: boolean | undefined): Promise<(name: 'TOpen' | 'TClosed') => unknown> {
  const { root, sourceRoot } = modelProject(t);
  fs.writeFileSync(path.join(sourceRoot, 'exact.model.ts'), `import type { IObject } from '@exprtlabs/golem/model';
export type TOpen = IObject<{ id: string }>;
export type TClosed = IObject<{ id: string }, { exact: true }>;
`);
  writeModelGolemYaml(root, { ...profile(), ...(exact === undefined ? {} : { exact }) });
  await compileModel(root);
  await import(path.toNamespacedPath(path.join(root, 'build/exact.model.generated.js')));
  return name => requireObjectCodec(generatedCodecIdFromRoot(root, name)).assert({ id: 'a', extra: 1 });
}

test('exact: false in golem.yaml opens a model that sets no exact option, and a model option exact: true closes it again', async (t: TestContext) => {
  const assertWithExtra = await buildExactModels(t, false);
  assert.doesNotThrow(() => assertWithExtra('TOpen'));
  assert.throws(() => assertWithExtra('TClosed'), (error: unknown) => {
    assert.ok(error instanceof LibError);
    assert.deepEqual(error.issues[0]?.path, ['extra']);
    return true;
  });
});

test('a golem.yaml without the exact key closes a model that sets no exact option', async (t: TestContext) => {
  const assertWithExtra = await buildExactModels(t, undefined);
  assert.throws(() => assertWithExtra('TOpen'), LibError);
});

test('referenced models retain their own allowAny policy instead of inheriting the referring model policy', (t: TestContext) => {
  const allowed = modelProject(t);
  fs.writeFileSync(allowed.source, referencedPolicyModelSource({ childAllowsAny: true }).text);
  const allowedResult = generate({
    root: allowed.root,
    sources: [allowed.source],
    profile: profile({ allowAny: false }),
  });
  assertModelArtifactRoles(allowed.root, allowed.source, allowedResult, true);

  const rejected = modelProject(t);
  fs.writeFileSync(rejected.source, referencedPolicyModelSource({ childAllowsAny: false }).text);
  assert.throws(
    () => generate({
      root: rejected.root,
      sources: [rejected.source],
      profile: profile({ allowAny: true }),
    }),
    /contains any|allowAny/,
  );
});

for (const item of [
  { name: 'default-exact', global: true, options: tsSource`{}` },
  { name: 'per-model', global: false, options: tsSource`{ exact: true, allowAny: true }` },
] as const) {
  test(`generated ${item.name} allowAny retains explicit tags through exact model and wire validation`, async t => {
    const { root, sourceRoot, source } = modelProject(t);
    fs.writeFileSync(path.join(sourceRoot, 'validators.ts'), readFixture('models/profile-options/validators.ts'));
    fs.writeFileSync(source, taggedProfilePayloadSource({ modelOptions: item.options }).text);
    writeModelGolemYaml(root, profile({ allowAny: item.global }));
    await compileModel(root);
    const { Payload } = await import(path.toNamespacedPath(path.join(root, 'build/payload.model.js')));

    const model = new Payload({ nested: { text: 'bad', payload: 'x', opaque: 1 } });
    assert.equal(await getValidator(model).validate({ failFast: false }), false);
    assert.deepEqual(getValidator(model).issues.map((issue: Issue) => ({
      code: issue.code,
      path: issue.path,
      source: issue.source,
      representation: issue.representation,
    })), [
      { code: 'tooSmall', path: ['nested', 'payload'], source: IssueSource.TypeScript, representation: IssueRepresentation.Model },
      { code: 'custom', path: ['nested', 'text'], source: IssueSource.Custom, representation: IssueRepresentation.Model },
    ]);

    const admitted = new Payload({ nested: { text: 'ok', payload: 7, opaque: 1 } });
    assert.equal(await getValidator(admitted).validate({ failFast: false }), true, 'an explicit any tag must not infer a string base type');

    assert.throws(
      () => requireObjectCodec(generatedCodecIdFromRoot(root, 'TPayload')).assert( {
        nested: { text: 'bad', payload: 'x', opaque: 1 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof LibError);
        assert.equal(error.kind, LibErrorKind.Validation);
        assert.deepEqual(error.issues.map((issue: Issue) => ({
          code: issue.code,
          path: issue.path,
          source: issue.source,
          representation: issue.representation,
        })), [
          { code: 'tooSmall', path: ['nested', 'payload'], source: IssueSource.TypeScript, representation: IssueRepresentation.Model },
        ]);
        return true;
      },
    );
    assert.throws(
      () => requireObjectCodec(generatedCodecIdFromRoot(root, 'TPayload')).assert( {
        nested: { text: 'ok', payload: 'ok', opaque: 1 },
        extra: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof LibError);
        assert.equal(error.kind, LibErrorKind.Validation);
        assert.deepEqual(error.issues[0]?.path, ['extra']);
        return true;
      },
    );
  });
}
