import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { decodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { requireObjectCodec } from '@exprtlabs/codegen/serde';
import { IssueCode, IssueRepresentation, IssueSource, LibError, LibErrorKind, type Issue } from '@exprtlabs/codegen/errors';
import { getValidator } from '@exprtlabs/codegen/validation';
import type { CodegenProfile } from '#codegen/generator-api';
import { generate } from '#model/generator';
import { command, workspace } from './support/process.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { modelAliasSource, referencedPolicyModelSource, taggedProfilePayloadSource } from './fixture-templates/models/profile-options.js';
import { tsSource, type SourceFragment } from './source-template.js';

function profile(overrides: Partial<CodegenProfile> = {}): CodegenProfile {
  return {
    mobx: false,
    validation: true,
    ajvStandalone: false,
    allowAny: false,
    ...overrides,
  };
}

function modelProject(t: TestContext): { root: string; sourceRoot: string; source: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runic-profile-model-')));
  const sourceRoot = path.join(root, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  fs.symlinkSync(
    path.join(process.cwd(), 'packages/codegen'),
    path.join(root, 'node_modules/@exprtlabs/codegen'),
    'dir',
  );
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      skipLibCheck: true,
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
  await command(root, process.execPath, [
    path.join(workspace, 'node_modules/ttsc/lib/launcher/ttsc.js'),
    '-p',
    path.join(root, 'tsconfig.json'),
  ]);
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

  const sharedPath = path.join(root, 'src/generated/models/models.generated.ts');
  if (validation) {
    assert.match(companion.content, /createObjectCodec|validatePayload/);
  }

  // The provider is pure: artifact discovery must not write either generated role.
  assert.equal(fs.existsSync(companionPath), false);
  assert.equal(fs.existsSync(sharedPath), false);
}

for (const validation of [true, false] as const) {
  test(`global allowAny applies when validation=${validation}`, (t: TestContext) => {
    const { root, source } = modelProject(t);
    writeModel(source, tsSource`IModel<{ payload: any }>`);
    assert.throws(
      () => generate({ root, sources: [source], profile: profile({ validation }) }),
      /contains any|allowAny/,
    );

    const allowed = generate({
      root,
      sources: [source],
      profile: profile({ validation, allowAny: true }),
    });
    assertModelArtifactRoles(root, source, allowed, validation);
  });

  test(`per-model allowAny=true opts in and false tightens the global policy when validation=${validation}`, (t: TestContext) => {
    const optedIn = modelProject(t);
    writeModel(optedIn.source, tsSource`IModel<{ payload: any }, { allowAny: true }>`);
    const optedInResult = generate({
      root: optedIn.root,
      sources: [optedIn.source],
      profile: profile({ validation }),
    });
    assertModelArtifactRoles(optedIn.root, optedIn.source, optedInResult, validation);

    const tightened = modelProject(t);
    writeModel(tightened.source, tsSource`IModel<{ payload: any }, { allowAny: false }>`);
    assert.throws(
      () => generate({
        root: tightened.root,
        sources: [tightened.source],
        profile: profile({ validation, allowAny: true }),
      }),
      /contains any|allowAny/,
    );
  });
}

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
    const result = generate({ root, sources: [source], profile: profile({ allowAny: item.global }) });
    writeGeneratedArtifacts(result.artifacts);
    await compileModel(root);
    const { Payload } = await import(path.toNamespacedPath(path.join(sourceRoot, 'payload.model.js')));

    const model = new Payload({ nested: { text: 'bad', payload: 'x', opaque: 1 } });
    assert.equal(await getValidator(model).validate({ failFast: false }), false);
    assert.deepEqual(getValidator(model).issues.map((issue: Issue) => ({
      code: issue.code,
      path: issue.path,
      source: issue.source,
      representation: issue.representation,
    })), [
      { code: IssueCode.MinLength, path: ['nested', 'payload'], source: IssueSource.TypeScript, representation: IssueRepresentation.Model },
      { code: IssueCode.Custom, path: ['nested', 'text'], source: IssueSource.Custom, representation: IssueRepresentation.Model },
    ]);

    const admitted = new Payload({ nested: { text: 'ok', payload: 7, opaque: 1 } });
    assert.equal(await getValidator(admitted).validate({ failFast: false }), true, 'an explicit any tag must not infer a string base type');

    assert.throws(
      () => requireObjectCodec(generatedCodecIdFromRoot(root, 'Payload')).assert( {
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
          { code: IssueCode.MinLength, path: ['nested', 'payload'], source: IssueSource.TypeScript, representation: IssueRepresentation.Model },
        ]);
        return true;
      },
    );
    assert.throws(
      () => requireObjectCodec(generatedCodecIdFromRoot(root, 'Payload')).assert( {
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
