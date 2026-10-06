import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { generate as generateOpenApi } from '@exprtlabs/golem-openapi/generator';
import { generate } from '#model/generator';
import { command } from './support/process.js';
import { fixturePath, writeGeneratedArtifacts } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

const MODEL_SOURCE = /\.models?\.ts$/;
const SDK_MONEY_SPEC = 'models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-/money.yaml';

const CHECK_PRELUDE = `import type { WireFormat } from '@exprtlabs/golem/serde';
type Same<Left, Right> = (<Probe>() => Probe extends Left ? 1 : 2) extends (<Probe>() => Probe extends Right ? 1 : 2) ? true : false;
type NotAny<Value> = 0 extends 1 & Value ? false : true;
type Assert<Value extends true> = Value;
type MutuallyAssignable<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
`;

/**
 * Differences the identity check reports, with the weaker comparison that
 * still holds. The identity assertion carries `@ts-expect-error`, so an entry
 * fails once the drift disappears.
 */
const KNOWN_DRIFT: Readonly<Record<string, { readonly reason: string; readonly comparator: string }>> = {
  'wire-format/wire-kinds.model.ts#TTaggedLiterals': {
    reason: 'TypeScript cannot remove a tag from a tagged literal',
    comparator: 'MutuallyAssignable',
  },
};

/**
 * Fixtures that do not generate standalone, each with the error generation must fail with (a substring of its message). A fixture is either
 * a rejected declaration, or it needs setup this test does not do: a helper module, a companion or a project option it lacks.
 * Any other generation failure fails the test, and so does an entry whose fixture generates.
 */
const STANDALONE_SKIPS: Readonly<Record<string, { readonly reason: string; readonly error: string }>> = {
  'compiler-lifecycle__manifest-scale': { reason: 'needs the generated scale SDK', error: "Module '\"./sdk/types.js\"' has no exported member 'Item0'" },
  'constraint-callback-composition__handwritten-child-parent': { reason: 'needs its predicates module', error: 'RUNM1046: validation must be a single callable function' },
  'constraint-callback-composition__nested-value-callbacks': { reason: 'needs its predicates module', error: 'RUNM1046: validation must be a single callable function' },
  'constraint-portability__constraint-portability-a-model': { reason: 'needs its rules module', error: 'RUNM1046: validation must be a single callable function' },
  'generated-validation-execution__generated-validation-formats-nested-errors-without-replaying-field-getters': { reason: 'a consumer of a model source the test writes', error: "Cannot find module './getter-replay.model.generated.js'" },
  'generated-validation-execution__nested-whole-object-tag-messages-keep-the-child-path-and-serde-state-unchang': { reason: 'a consumer of a model source the test writes', error: "Cannot find module './tag-message.model.generated.js'" },
  'model-companions': { reason: 'a consumer of the models in its subdirectories', error: "Cannot find module './item.model.generated.js'" },
  'model-composition__a-projected-child-applies-the-containing-model-allowany-policy': { reason: 'rejected declaration: allowAny false over a projection that contains any', error: 'RUNM1011: Model TContainer contains any' },
  'model-composition__anonymous-nested-imodel-declarations-fail-with-an-actionable-diagnostic': { reason: 'rejected declaration: anonymous nested IModel', error: 'RUNM1053: Nested IModel definitions need a named, exported declaration' },
  'model-composition__first-generation-resolves-model-class-bases-through-project-path-aliases': { reason: 'needs the tsconfig path aliases of its project', error: 'RUNM1011: Model TParent contains any' },
  'model-composition__generic-model-templates-require-a-concrete-named-declaration': { reason: 'rejected declaration: generic IModel template', error: 'RUNM1057: IModel declarations must have concrete fields' },
  'model-composition__imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts': { reason: 'rejected declaration: root IModel union', error: 'RUNM1052: Root IModel unions are unsupported' },
  'model-tags__generic-aliases-preserve-concrete-local-model-identity-for-nested-conversion': { reason: 'needs the child model module it imports', error: "Cannot find module './child.model.js'" },
};

interface WireCheck {
  readonly label: string;
  readonly model: string;
  readonly json: string;
}

function importPath(from: string, to: string): string {
  const relative = path.relative(path.dirname(from), to).replace(/\\/g, '/').replace(/\.ts$/, '.js');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/** The model aliases and handwritten model classes a source declares: the declarations a caller may pass to `toWireFormat<T>`. */
function declaredModels(sourceFile: string): { aliases: string[]; classes: RegExpMatchArray[] } {
  const source = fs.readFileSync(sourceFile, 'utf8');
  return {
    aliases: [...source.matchAll(/^export type (\w+)\s*=\s*I(?:Model|Object)</gm)].map(match => match[1]!),
    classes: [...source.matchAll(/^export (?:abstract )?class (\w+) extends (\w+)BaseModel\b/gm)],
  };
}

/**
 * Pair every generator-emitted `XJSON` with the declarations a caller may pass
 * to `toWireFormat<T>`: the IModel/IObject alias and, for classes, the
 * handwritten subclass.
 */
function modelChecks(sourceFile: string, companionFile: string): { imports: string[]; checks: WireCheck[] } {
  const companion = fs.readFileSync(companionFile, 'utf8');
  const exported = new Set([...companion.matchAll(/^export type (\w+)JSON = /gm)].map(match => match[1]!));
  const { aliases, classes } = declaredModels(sourceFile);
  const sourceTypes: string[] = [];
  const jsonTypes = new Set<string>();
  const checks: WireCheck[] = [];
  for (const alias of aliases) {
    if (!exported.has(alias)) continue;
    sourceTypes.push(alias);
    jsonTypes.add(`${alias}JSON`);
    checks.push({ label: `${path.basename(sourceFile)}#${alias}`, model: alias, json: `${alias}JSON` });
  }
  for (const [, className, base] of classes) {
    if (!className || !base || !exported.has(base)) continue;
    sourceTypes.push(className);
    jsonTypes.add(`${base}JSON`);
    checks.push({ label: `${path.basename(sourceFile)}#${className}`, model: className, json: `${base}JSON` });
  }
  const imports = checks.length === 0 ? [] : [
    `import type { ${sourceTypes.join(', ')} } from '${importPath(companionFile, sourceFile)}';`,
    `import type { ${[...jsonTypes].join(', ')} } from '${importPath(companionFile, companionFile)}';`,
  ];
  return { imports, checks };
}

/** SDK models: the generated class (brand path) and its field type (structural path). */
function sdkChecks(facade: string, checkFile: string, scope: string): { imports: string[]; checks: WireCheck[] } {
  const text = fs.readFileSync(facade, 'utf8');
  const name = path.basename(facade, '.ts');
  if (!new RegExp(`\\b${name}Model\\b`).test(text) || !new RegExp(`\\b${name}JSON\\b`).test(text)) return { imports: [], checks: [] };
  const local = `${scope}_${name}`.replace(/\W/g, '_');
  return {
    imports: [`import type { ${name}Model as ${local}Model, ${name}Fields as ${local}Fields, ${name}JSON as ${local}JSON } from '${importPath(checkFile, facade)}';`],
    checks: [
      { label: `${local}Model`, model: `${local}Model`, json: `${local}JSON` },
      { label: `${local}Fields`, model: `${local}Fields`, json: `${local}JSON` },
    ],
  };
}

function checkSource(imports: readonly string[], checks: readonly WireCheck[]): string {
  return [
    ...imports,
    CHECK_PRELUDE,
    ...checks.flatMap((check, index) => {
      const drift = KNOWN_DRIFT[check.label];
      return [
      `// ${check.label}`,
      ...(drift ? [
        `// @ts-expect-error known drift: ${drift.reason}.`,
        `export type Same${index} = Assert<Same<WireFormat<${check.model}>, ${check.json}>>;`,
        `export type Weaker${index} = Assert<${drift.comparator}<WireFormat<${check.model}>, ${check.json}>>;`,
      ] : [`export type Same${index} = Assert<Same<WireFormat<${check.model}>, ${check.json}>>;`]),
      `export type NotAny${index} = Assert<NotAny<WireFormat<${check.model}>>>;`,
      ];
    }),
    '',
  ].join('\n');
}

function modelFixtureDirectories(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const own = entries.some(entry => entry.isFile() && MODEL_SOURCE.test(entry.name)) ? [directory] : [];
  return [...own, ...entries.filter(entry => entry.isDirectory()).flatMap(entry => modelFixtureDirectories(path.join(directory, entry.name)))];
}

test('WireFormat<T> equals the generator-emitted JSON type for fixture models and generated SDK models', async t => {
  const { root } = createModelProject(t, {
    prefix: 'golem-wire-format-',
    name: 'wire-format',
    linkWorkspaceNodeModules: true,
    rootDir: '.',
    include: ['fixtures/**/*.ts', 'checks/**/*.ts'],
    compilerOptions: { noEmit: true },
  });
  const covered: string[] = [];
  const skipped = new Set<string>();
  // Every model declaration and SDK facade of a fixture that generates: each must come out as an equivalence check.
  const expected: string[] = [];
  const fixtures = fixturePath('models');
  for (const directory of modelFixtureDirectories(fixtures)) {
    const slug = path.relative(fixtures, directory).replace(/[\\/]/g, '__');
    const projectRoot = path.join(root, 'fixtures', slug);
    const sourceRoot = path.join(projectRoot, 'src');
    // Copy model sources and the local modules they import; consumers and alternates stay out.
    const sources: Record<string, string> = {};
    const pending = fs.readdirSync(directory).filter(name => MODEL_SOURCE.test(name));
    while (pending.length > 0) {
      const name = pending.pop()!;
      const file = path.join(directory, name);
      if (sources[name] !== undefined || !fs.existsSync(file)) continue;
      sources[name] = fs.readFileSync(file, 'utf8');
      for (const match of sources[name].matchAll(/from '\.\/([\w.-]+)\.js'/g)) {
        if (!match[1]!.endsWith('.generated')) pending.push(`${match[1]}.ts`);
      }
    }
    writeModelSources(sourceRoot, sources);
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const modelSources = Object.keys(sources).filter(name => MODEL_SOURCE.test(name)).map(name => path.join(sourceRoot, name));
    let artifacts;
    // Models that use an SDK `Money` get a real generated SDK and its manifest.
    const usesSdk = Object.values(sources).some(text => text.includes("from './sdk/"));
    try {
      if (usesSdk) {
        writeGeneratedArtifacts((await generateOpenApi({
          input: fixturePath(SDK_MONEY_SPEC),
          output: path.join(sourceRoot, 'sdk'),
          name: 'Payments',
          profile: { mobx: false, validation: true },
        })).artifacts);
      }
      artifacts = generate({
        root: projectRoot,
        sources: modelSources,
        profile: { mobx: false, validation: true },
        ...(usesSdk ? { manifestInputs: [path.join(sourceRoot, 'sdk/model-manifest.json')] } : {}),
      }).artifacts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const skip = STANDALONE_SKIPS[slug];
      if (!skip || !message.includes(skip.error)) throw new Error(`Fixture ${slug} failed to generate: ${message}`, { cause: error });
      skipped.add(slug);
      fs.rmSync(projectRoot, { recursive: true, force: true });
      continue;
    }
    writeGeneratedArtifacts(artifacts);
    if (usesSdk) {
      // The generated SDK's model facades: the class (brand path) and its field type (structural path).
      const sdkCheckFile = path.join(sourceRoot, 'sdk.wire-check.ts');
      const sdkImports: string[] = [];
      const sdkWireChecks: WireCheck[] = [];
      const facadeDirectory = path.join(sourceRoot, 'sdk', 'models');
      for (const name of fs.readdirSync(facadeDirectory).filter(entry => /^[A-Z]\w*\.ts$/.test(entry))) {
        const result = sdkChecks(path.join(facadeDirectory, name), sdkCheckFile, slug);
        sdkImports.push(...result.imports);
        sdkWireChecks.push(...result.checks.map(check => ({ ...check, label: `${slug}/sdk/${check.label}` })));
        const local = `${slug}_${path.basename(name, '.ts')}`.replace(/\W/g, '_');
        expected.push(...['Model', 'Fields'].map(kind => `${slug}/sdk/${local}${kind}`));
      }
      if (sdkWireChecks.length > 0) {
        fs.writeFileSync(sdkCheckFile, checkSource(sdkImports, sdkWireChecks));
        covered.push(...sdkWireChecks.map(check => check.label));
      }
    }
    for (const modelSource of modelSources) {
      const { aliases, classes } = declaredModels(modelSource);
      expected.push(...[...aliases, ...classes.map(match => match[1]!)].map(name => `${slug}/${path.basename(modelSource)}#${name}`));
      const companion = modelSource.replace(MODEL_SOURCE, match => match.replace('.ts', '.generated.ts'));
      if (!fs.existsSync(companion)) continue;
      const result = modelChecks(modelSource, companion);
      if (result.checks.length === 0) continue;
      const checks = result.checks.map(check => ({ ...check, label: `${slug}/${check.label}` }));
      const checkFile = companion.replace(/\.generated\.ts$/, '.wire-check.ts');
      fs.writeFileSync(checkFile, checkSource(result.imports, checks));
      covered.push(...checks.map(check => check.label));
    }
  }

  const controlChecks = path.join(root, 'checks');
  fs.mkdirSync(controlChecks, { recursive: true });

  // A collapsed Same/Assert would accept anything; this control must fail.
  fs.writeFileSync(path.join(controlChecks, 'control.ts'), `${CHECK_PRELUDE}
// @ts-expect-error A Date field is a string on the wire.
export type DateStaysDate = Assert<Same<WireFormat<{ at: Date }>, { at: Date }>>;
// @ts-expect-error any is not a wire type.
export type AnyWire = Assert<NotAny<WireFormat<any>>>;
`);

  t.diagnostic(`covered ${covered.length} of ${expected.length} expected labels; skipped ${skipped.size} fixtures`);
  const unskipped = Object.keys(STANDALONE_SKIPS).filter(slug => !skipped.has(slug));
  assert.deepEqual(unskipped, [], 'declared skips whose fixture now generates or is gone: remove them from STANDALONE_SKIPS');
  const unchecked = expected.filter(label => !covered.includes(label));
  assert.deepEqual(unchecked, [], `no equivalence check for ${unchecked.join(', ')}`);
  const result = await buildModelProject(root, [], { allowFailure: true });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
});

test('WireFormat<T> equals the emitted JSON type for nested and omitted-field SDK models with and without mobx', async t => {
  const { root } = createModelProject(t, {
    prefix: 'golem-wire-format-sdk-',
    name: 'wire-format-sdk',
    linkWorkspaceNodeModules: true,
    rootDir: '.',
    include: ['fixtures/**/*.ts'],
    compilerOptions: { noEmit: true },
  });
  const covered: string[] = [];
  for (const mobx of [false, true]) {
    const scope = `sdk-mobx-${mobx}`;
    const projectRoot = path.join(root, 'fixtures', scope);
    const sdk = path.join(projectRoot, 'sdk');
    writeGeneratedArtifacts((await generateOpenApi({
      input: fixturePath('wire-format/nested-sdk.yaml'),
      output: sdk,
      name: 'Payments',
      profile: { mobx, validation: true },
    })).artifacts);
    const checkFile = path.join(projectRoot, 'sdk.wire-check.ts');
    const imports: string[] = [];
    const checks: WireCheck[] = [];
    for (const name of fs.readdirSync(path.join(sdk, 'models')).filter(entry => /^[A-Z]\w*\.ts$/.test(entry))) {
      const result = sdkChecks(path.join(sdk, 'models', name), checkFile, scope);
      imports.push(...result.imports);
      checks.push(...result.checks.map(check => ({ ...check, label: `${scope}/${check.label}` })));
    }
    fs.writeFileSync(checkFile, checkSource(imports, checks));
    covered.push(...checks.map(check => check.label));
  }
  for (const mobx of [false, true]) {
    for (const model of ['Payment', 'Merchant', 'MerchantOmitId']) {
      for (const kind of ['Model', 'Fields']) {
        const label = `sdk-mobx-${mobx}/sdk_mobx_${mobx}_${model}${kind}`;
        assert.ok(covered.includes(label), `missing equivalence check ${label}`);
      }
    }
  }
  const result = await buildModelProject(root, [], { allowFailure: true });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
});

test('toWireFormat<T> returns the emitted JSON type through the golem rewrite without a cast', async t => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-wire-format-call-',
    name: 'wire-format-call',
    linkWorkspaceNodeModules: true,
  });
  writeModelSources(sourceRoot, {
    'payment-editor.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Minimum } from '@exprtlabs/golem/tags';
import { TPaymentEditorBaseModel } from './payment-editor.model.generated.js';

export type TPaymentEditor = IModel<{ amount: number & Minimum<0>; note: string; paidAt: Date }>;

export class PaymentEditor extends TPaymentEditorBaseModel {
  public get summary(): string {
    return \`\${this.amount}: \${this.note}\`;
  }
}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  writeModelSources(sourceRoot, {
    'main.ts': `import { toWireFormat } from '@exprtlabs/golem/serde';
import { PaymentEditor, type TPaymentEditor } from './payment-editor.model.js';
import type { TPaymentEditorJSON } from './payment-editor.model.generated.js';

const editor = new PaymentEditor({ amount: 30, note: 'Lunch', paidAt: new Date('2026-01-02T03:04:05.000Z') });
const wire: TPaymentEditorJSON = toWireFormat<TPaymentEditor>(editor);
const fromClass = toWireFormat<PaymentEditor>(editor);
const paidAt: string = fromClass.paidAt;
// @ts-expect-error summary is a model getter, not a wire field.
void fromClass.summary;
// @ts-expect-error paidAt is an ISO string on the wire.
const paidAtDate: Date = toWireFormat<TPaymentEditor>(editor).paidAt;
void paidAtDate;
console.log(JSON.stringify({ wire, paidAt }));
`,
  });
  await buildModelProject(root);
  const result = await command(root, process.execPath, [path.join(root, 'build/main.js')]);
  assert.deepEqual(JSON.parse(result.stdout), {
    wire: { amount: 30, note: 'Lunch', paidAt: '2026-01-02T03:04:05.000Z' },
    paidAt: '2026-01-02T03:04:05.000Z',
  });
});

test('wire output omits optional fields that are absent or undefined', async t => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'golem-wire-format-optional-',
    name: 'wire-format-optional',
    linkWorkspaceNodeModules: true,
  });
  writeModelSources(sourceRoot, {
    'visit.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TSlotBaseModel, TVisitBaseModel } from './visit.model.generated.js';

export type TSlot = IModel<{ at: Date; room?: string }>;
export type TVisit = IModel<{
  at: Date;
  note?: string;
  slot?: TSlot;
  detail?: { at: Date; memo?: string };
  window?: Partial<Pick<TSlot, 'at' | 'room'>>;
}>;
export class Slot extends TSlotBaseModel {}
export class Visit extends TVisitBaseModel {}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const generated = await import(pathToFileURL(path.join(root, 'build/visit.model.generated.js')).href) as {
    readonly toWireFormatTVisit: (value: unknown) => Record<string, unknown>;
    readonly stringifyTVisit: (value: unknown) => string;
  };
  const { Visit } = await import(pathToFileURL(path.join(root, 'build/visit.model.js')).href) as {
    readonly Visit: new (values: object) => object;
  };
  const { encodeGeneratedModel } = await import('@exprtlabs/golem/conversion');
  const at = new Date('2026-01-02T03:04:05.000Z');
  const encoders = [
    ['toWireFormat', generated.toWireFormatTVisit],
    ['encodeGeneratedModel', (value: unknown) => encodeGeneratedModel(value as never) as Record<string, unknown>],
  ] as const;
  const visits = [
    ['absent', new Visit({ at, detail: { at }, window: {} })],
    ['undefined', new Visit({ at, note: undefined, slot: undefined, detail: { at, memo: undefined }, window: { at: undefined, room: undefined } })],
  ] as const;
  for (const [encoderName, encode] of encoders) {
    for (const [visitName, visit] of visits) {
      const label = `${encoderName}, ${visitName}`;
      const wire = encode(visit);
      assert.deepEqual(Object.keys(wire), ['at', 'detail', 'window'], label);
      assert.deepEqual(Object.keys(wire.window as object), [], `${label}: projection`);
      // A nested plain object keeps an authored undefined key; an absent one stays absent.
      if (visitName === 'absent') assert.deepEqual(Object.keys(wire.detail as object), ['at'], `${label}: nested object`);
      assert.equal(JSON.stringify(wire), generated.stringifyTVisit(visit), `${label}: matches stringify`);
    }
  }
});
