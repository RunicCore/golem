import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { writeModelSources } from './model-project.js';
import { literal, tsSource, type SourceFragment } from './source-template.js';
import { createJobAnalysis } from '#model/emit';
import { generate } from '#model/generator';
import { collectSpecifications, createProgram, isOwnModelFile, loadModelManifests, modelBoundary } from '@exprtlabs/golem/type-analysis';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const PROFILE = { mobx: false, validation: false };
const CUSTOMER = tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TCustomer = IModel<{ name: string & MinLength<3> }>;
`;
const ORDER = (from: string): SourceFragment => tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TCustomer } from ${literal(from)};
export type TOrder = IModel<{ customer: TCustomer }>;
`;

const PLAIN_ORDER = tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TOrder = IModel<{ id: string }>;
`;

/** `outer/app` (tsconfig includes `../shared`) next to `outer/shared`, which holds `customer.model.ts`. */
function appBesideShared(t: TestContext, order: string | undefined, shared: Readonly<Record<string, string | SourceFragment>> = {}): { readonly outer: string; readonly root: string } {
  const outer = createFixtureProject(t, 'golem-shared-files-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  const root = path.join(outer, 'app');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true },
    include: ['src/**/*.ts', '../shared/**/*.ts'],
  }));
  writeModelSources(path.join(root, 'src'), { 'order.model.ts': order === undefined ? PLAIN_ORDER : ORDER(order) });
  writeModelSources(path.join(outer, 'shared'), { 'package.json': JSON.stringify({ name: '@acme/shared', private: true, type: 'module' }), 'customer.model.ts': CUSTOMER, ...shared });
  return { outer, root: fs.realpathSync(root) };
}

/** Installs `@acme/shared` in `outer/node_modules` with a `.model.d.ts` file whose alias has a tag, and a TSerde tag. */
function installSharedDeclarations(outer: string): string {
  const packageRoot = path.join(outer, 'node_modules/@acme/shared');
  writeModelSources(packageRoot, {
    'package.json': JSON.stringify({ name: '@acme/shared', version: '1.0.0', type: 'module', exports: { './customer.model': { types: './customer.model.d.ts' }, './codecs': { types: './codecs.d.ts', import: './codecs.js' } } }),
    'codecs.d.ts': 'export declare function encodeCount(value: number): string;\nexport declare function decodeCount(value: string): number;\n',
    'codecs.js': 'export function encodeCount(value) { return String(value); }\nexport function decodeCount(value) { return Number(value); }\n',
    'customer.model.d.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength, TSerde } from '@exprtlabs/golem/tags';
import type { encodeCount, decodeCount } from './codecs.js';
export type TCustomer = IModel<{ name: string & MinLength<3>; visits: number & TSerde<typeof encodeCount, typeof decodeCount> }>;
`,
  });
  return fs.realpathSync(path.join(packageRoot, 'customer.model.d.ts'));
}

test('type analysis reads the tags of an alias in the .model.d.ts file of an installed package, and the app model nests it as a model', (t: TestContext) => {
  // protects: R-20 an installed package declares models
  const { outer, root } = appBesideShared(t, '@acme/shared/customer.model');
  fs.rmSync(path.join(outer, 'shared'), { recursive: true });
  const declaration = installSharedDeclarations(outer);
  const order = path.join(root, 'src/order.model.ts');
  const info = createProgram([order], root);
  const { checker, specifications } = collectSpecifications(info.program, [order, declaration]);
  const job = createJobAnalysis(checker, specifications, loadModelManifests(root, info, [], PROFILE), PROFILE, [order], root, info.options);
  const describe = (name: string): { properties: Record<string, object> } => {
    const specification = specifications.find((item) => item.name === name);
    assert.ok(specification);
    return job.describe(specification.fieldsType, specification, undefined, specification.fieldsNode) as unknown as { properties: Record<string, object> };
  };

  const customer = describe('TCustomer').properties;
  assert.deepEqual((customer.name as { constraints: object[] }).constraints, [{ kind: 'minLength', value: 3 }]);
  assert.equal((customer.visits as { serde: { serialize: { exportName: string } } }).serde.serialize.exportName, 'encodeCount');
  assert.deepEqual(describe('TOrder').properties.customer, { kind: 'reference', name: 'TCustomer' });
});

test('a model file is own only inside the models root: a folder, a folder link, a linked package and node_modules hold shared files', (t: TestContext) => {
  // protects: R-20 three kinds of model file
  const { outer, root } = appBesideShared(t, '../../shared/customer.model.js');
  fs.symlinkSync('../../shared', path.join(root, 'src/linked'), 'dir');
  fs.mkdirSync(path.join(root, 'node_modules/@acme/own'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/@acme/own/own.model.ts'), '');
  fs.writeFileSync(path.join(root, 'src/types.model.d.ts'), '');
  const boundary = modelBoundary(root);
  const kinds = [
    path.join(root, 'src/order.model.ts'),
    path.join(outer, 'shared/customer.model.ts'),
    path.join(root, 'src/linked/customer.model.ts'),
    installSharedDeclarations(outer),
    path.join(root, 'node_modules/@acme/own/own.model.ts'),
    path.join(root, 'src/types.model.d.ts'),
  ].map((file) => isOwnModelFile(boundary, file));
  assert.deepEqual(kinds, [true, false, false, false, false, false]);
});

test('a golem.yaml in a shared folder gives one warning that names it, and generation goes on without it', (t: TestContext) => {
  // protects: D-34 warn about a golem.yaml in a shared package, no hard reject
  const { outer, root } = appBesideShared(t, undefined, {
    'golem.yaml': 'version: 1\n',
    'address.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TAddress = IObject<{ street: string }>;
`,
  });
  const yaml = path.join(fs.realpathSync(path.join(outer, 'shared')), 'golem.yaml');

  const result = generate({ root, profile: PROFILE });

  assert.deepEqual(result.diagnostics?.map(({ code, severity, file }) => ({ code, severity, file })), [{ code: 'RUNM1076', severity: 'warning', file: yaml }]);
  assert.match(result.diagnostics?.[0].message ?? '', new RegExp(`^${yaml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is a golem.yaml in the shared folder of the model file .*Golem does not read it. A shared package holds no golem.yaml. Delete it.$`));
  assert.ok(result.artifacts.some((artifact) => artifact.path === path.join(root, 'src/order.model.generated.ts')));
});

test('a golem.yaml of another app beside a shared model file gives a warning that says to move the model', (t: TestContext) => {
  // protects: D-34 another app's golem.yaml warning names the way out
  const { outer, root } = appBesideShared(t, undefined, { 'golem.yaml': 'version: 1\nmodels:\n  root: .\n' });

  const { diagnostics } = generate({ root, profile: PROFILE });

  assert.equal(diagnostics?.length, 1);
  assert.match(diagnostics?.[0].message ?? '', /It configures another app that generates customer\.model\.ts\. Move the model into a shared package that holds no golem\.yaml, and have each app use it from there\.$/);
  assert.equal(diagnostics?.[0].file, path.join(fs.realpathSync(path.join(outer, 'shared')), 'golem.yaml'));
});

test('a generated file beside a shared model file gives one warning each, and generation goes on without them', (t: TestContext) => {
  // protects: D-34 warn about a companion beside a shared model file
  const { outer, root } = appBesideShared(t, undefined, {
    'customer.model.generated.ts': 'export {};\n',
    'customer.model.generated.js': 'export {};\n',
    'customer.model.generated.d.ts': 'export {};\n',
  });
  const shared = fs.realpathSync(path.join(outer, 'shared'));

  const result = generate({ root, profile: PROFILE });

  assert.deepEqual(result.diagnostics?.map(({ code, file }) => ({ code, file })), ['d.ts', 'js', 'ts'].map((form) => ({ code: 'RUNM1076', file: path.join(shared, `customer.model.generated.${form}`) })));
  assert.ok(result.artifacts.some((artifact) => artifact.path === path.join(root, 'src/order.model.generated.ts')));
});
