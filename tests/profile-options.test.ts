import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { IssueRepresentation, IssueSource, LibError, LibErrorKind, type Issue } from '@exprtlabs/golem/errors';
import { getValidator } from '@exprtlabs/golem/validation';
import { resolveProfile, type GolemProfile } from '#golem/generator-api';
import { generate } from '#model/generator';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { readFixture } from './fixture-project.js';
import { modelAliasSource, referencedPolicyModelSource, taggedProfilePayloadSource } from './fixture-templates/models/profile-options.js';
import { openScope, runModule } from './support/run-module.js';
import { identifier, tsSource, type SourceFragment } from './source-template.js';

function profile(overrides: Partial<GolemProfile> = {}): GolemProfile {
  return {
    validation: true,
    allowAny: false,
    ...overrides,
  };
}

function modelProject(t: TestContext): { root: string; sourceRoot: string; source: string } {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-profile-model-', linkTypescript: true });
  return { root, sourceRoot, source: path.join(sourceRoot, 'payload.model.ts') };
}

/** The identity of each issue: the part of an issue that these tests compare. */
function issueSummary(issues: readonly Issue[]): readonly Pick<Issue, 'code' | 'path' | 'source' | 'representation'>[] {
  return issues.map(issue => ({
    code: issue.code,
    path: issue.path,
    source: issue.source,
    representation: issue.representation,
  }));
}

function writeModel(source: string, declaration: SourceFragment): void {
  fs.writeFileSync(source, modelAliasSource({ declaration }).text);
}

async function compileModel(root: string): Promise<void> {
  await buildModelProject(root);
}

/** The `profile.validation` option of each `registerGeneratedModel` call that the companion makes when it runs with its imports stubbed. */
function registeredValidation(companion: string): unknown[] {
  const profiles: unknown[] = [];
  const runtime = openScope({
    registerGeneratedModel: (_model: unknown, options: { readonly profile: { readonly validation: unknown } }) => { profiles.push(options.profile.validation); },
  });
  runModule(companion, { require: () => runtime, exports: {}, module: { exports: {} } }, { format: 'cjs' });
  return profiles;
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
  assert.deepEqual([...new Set(registeredValidation(companion.content))], [validation], 'the companion registers every model under the validation profile');

  const validatorsPath = path.join(root, 'src/generated/models/models.validators.generated.ts');

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
export type TPayload = IModel<{ opaque: unknown & Format<'uuid'> }>;
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

test('a pick of a key an index signature holds is a field typed unknown, so allowAny is advised', (t: TestContext) => {
  // protects: T-212 RUNM1011 for a Pick from an index-signature type, not RUNM1058 (found in T-211)
  const { root, source } = modelProject(t);
  fs.writeFileSync(source, `import type { IModel } from '@exprtlabs/golem/model';
type Source = { [key: string]: unknown };
export type TPayload = IModel<{ view: Pick<Source, 'b'> }>;
`);
  assert.throws(() => generate({ root, sources: [source], profile: profile() }), (error: unknown) => {
    assert.match(String(error), /RUNM1011.*contains unknown.*allowAny/);
    assert.doesNotMatch(String(error), /RUNM1058/);
    return true;
  });
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
    assert.deepEqual(issueSummary(getValidator(model).issues), [
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
        assert.deepEqual(issueSummary(error.issues), [
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

type Level = boolean | 'sanity';
/** The diagnostic message from the model file name on, so the literal does not depend on the temporary folder. */
function fromModelFile(error: unknown): { readonly code: unknown; readonly text: string } {
  const { code, message } = error as { code?: unknown; message: string };
  return { code, text: message.slice(message.indexOf('payload.model.ts')) };
}
const show = (level: Level): string => (level === 'sanity' ? "'sanity'" : String(level));

test('resolveProfile takes validation true, false and sanity and refuses every other value', () => {
  // protects: T-663 an extension author's GolemProfile carries validation: 'sanity'; other values are a TypeError
  for (const validation of [true, false, 'sanity'] as const) {
    assert.deepEqual(resolveProfile({ validation }), { validation, allowAny: false, unknownFormats: 'error' });
  }
  for (const validation of ['full', 'true', 1, null, undefined]) {
    assert.throws(
      () => resolveProfile({ validation } as unknown as GolemProfile),
      { name: 'TypeError', message: 'Generation profile validation must be true, false or "sanity".' },
      String(validation),
    );
  }
});

const MODEL_SOURCE = (model: Level): string =>
  `import type { IModel } from '@exprtlabs/golem/model';\nexport type TCard = IModel<{ id: string }, { validation: ${show(model)} }>;\n`;

const ALLOWED_ROWS: readonly (readonly [project: Level, model: Level])[] = [
  [true, true], [true, 'sanity'], [true, false], ['sanity', 'sanity'], ['sanity', false], [false, false],
];
const REFUSED_ROWS: readonly (readonly [project: Level, model: Level])[] = [['sanity', true], [false, 'sanity'], [false, true]];

for (const [project, model] of ALLOWED_ROWS) {
  test(`a model at validation ${show(model)} in a project at ${show(project)} generates`, (t: TestContext) => {
    // protects: T-663 a model lowers the validation level of its project (false < 'sanity' < true)
    const { root, source } = modelProject(t);
    fs.writeFileSync(source, MODEL_SOURCE(model));
    assert.ok(generate({ root, sources: [source], profile: profile({ validation: project }) }));
  });
}

for (const [project, model] of REFUSED_ROWS) {
  test(`a model at validation ${show(model)} in a project at ${show(project)} stops with RUNM1089`, (t: TestContext) => {
    // protects: T-663 a model never raises the validation level of its project
    const { root, source } = modelProject(t);
    fs.writeFileSync(source, MODEL_SOURCE(model));
    assert.throws(() => generate({ root, sources: [source], profile: profile({ validation: project }) }), (error: unknown) => {
      assert.deepEqual(fromModelFile(error), {
        code: 'RUNM1089',
        text: `payload.model.ts:2:1 RUNM1089: TCard sets validation ${show(model)}, which is above the project level ${show(project)}. A model may lower the level of its project, never raise it. Set the model to ${show(project)} or lower, or raise validation in golem.yaml.`,
      });
      return true;
    });
  });
}

test('a model validation option that is none of true, false and sanity stops with RUNM1089 naming the key and the allowed values', (t: TestContext) => {
  // protects: T-663 any other per-model validation value is an error, not a silent inherit
  const { root, source } = modelProject(t);
  fs.writeFileSync(source, "import type { IModel } from '@exprtlabs/golem/model';\nexport type TCard = IModel<{ id: string }, { validation: 'full' }>;\n");
  assert.throws(() => generate({ root, sources: [source], profile: profile() }), (error: unknown) => {
    assert.deepEqual(fromModelFile(error), { code: 'RUNM1089', text: 'payload.model.ts:2:1 RUNM1089: The validation option of TCard must be true, false or "sanity". It is "full".' });
    return true;
  });
});

function writeManifestProject(t: TestContext, manifest: Level): { readonly root: string; readonly source: string; readonly manifestFile: string } {
  const { root, source } = modelProject(t);
  fs.writeFileSync(source, "import type { IModel } from '@exprtlabs/golem/model';\nexport type TCard = IModel<{ id: string }>;\n");
  const manifestFile = path.join(root, 'external-model-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ profile: { validation: manifest, allowAny: false, unknownFormats: 'error' }, models: [] }));
  return { root, source, manifestFile };
}

test('an SDK manifest at validation sanity matches a project at sanity', (t: TestContext) => {
  // protects: T-663 an SDK and its app at the same level are accepted
  const { root, source, manifestFile } = writeManifestProject(t, 'sanity');
  assert.ok(generate({ root, sources: [source], profile: profile({ validation: 'sanity' }), manifestInputs: [manifestFile] }));
});

for (const [manifest, project] of [['sanity', true], [true, 'sanity'], [false, 'sanity'], ['sanity', false]] as const) {
  test(`an SDK manifest at validation ${show(manifest)} is refused by a project at ${show(project)}`, (t: TestContext) => {
    // protects: T-663 mixed app and SDK levels are refused for any difference, and the message prints both levels
    const { root, source, manifestFile } = writeManifestProject(t, manifest);
    assert.throws(
      () => generate({ root, sources: [source], profile: profile({ validation: project }), manifestInputs: [manifestFile] }),
      new RegExp(`profile mismatch in .*: validation: manifest ${manifest}, project ${project}\\. The project expects \\{ validation: ${project},`),
    );
  });
}
