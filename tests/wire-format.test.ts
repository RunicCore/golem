import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { generate as generateOpenApi } from '@exprtlabs/openapi-to-ts/generator';
import { generate } from '#model/generator';
import { command, ttsc } from './support/process.js';
import { fixturePath, writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject, writeModelSources } from './model-project.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
// modelName is internal to the built package; load it from dist instead of compiling package source into the tests.
const distRoot = path.dirname(fileURLToPath(import.meta.resolve('@exprtlabs/codegen/model')));
const { modelName } = await import(pathToFileURL(path.join(distRoot, 'model-name.js')).href) as {
  readonly modelName: (aliasName: string) => string;
};

const EXAMPLES = ['model', 'model-mobx', 'combined', 'combined-mobx', 'showcase', 'nest-openapi', 'react-mobx', 'openapi'] as const;
const MODEL_SOURCE = /\.models?\.ts$/;
const SDK_MONEY_SPEC = 'models/unify-validate/sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-/money.yaml';

const CHECK_PRELUDE = `import type { WireFormat } from '@exprtlabs/codegen/serde';
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

interface WireCheck {
  readonly label: string;
  readonly model: string;
  readonly json: string;
}

function importPath(from: string, to: string): string {
  const relative = path.relative(path.dirname(from), to).replace(/\\/g, '/').replace(/\.ts$/, '.js');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Pair every generator-emitted `XJSON` with the declarations a caller may pass
 * to `toWireFormat<T>`: the IModel/IObject alias and, for classes, the
 * handwritten subclass.
 */
function modelChecks(sourceFile: string, companionFile: string): { imports: string[]; checks: WireCheck[] } {
  const source = fs.readFileSync(sourceFile, 'utf8');
  const companion = fs.readFileSync(companionFile, 'utf8');
  const exported = new Set([...companion.matchAll(/^export type (\w+)JSON = /gm)].map(match => match[1]!));
  const aliases = [...source.matchAll(/^export type (\w+)\s*=\s*I(?:Model|Object)</gm)].map(match => match[1]!);
  const classes = [...source.matchAll(/^export (?:abstract )?class (\w+) extends (\w+)Base\b/gm)];
  const sourceTypes: string[] = [];
  const jsonTypes = new Set<string>();
  const checks: WireCheck[] = [];
  for (const alias of aliases) {
    const name = modelName(alias);
    if (!exported.has(name)) continue;
    sourceTypes.push(alias);
    jsonTypes.add(`${name}JSON`);
    checks.push({ label: `${path.basename(sourceFile)}#${alias}`, model: alias, json: `${name}JSON` });
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
function sdkChecks(facade: string, checkFile: string): { imports: string[]; checks: WireCheck[] } {
  const text = fs.readFileSync(facade, 'utf8');
  const name = path.basename(facade, '.ts');
  if (!new RegExp(`\\b${name}Model\\b`).test(text) || !new RegExp(`\\b${name}JSON\\b`).test(text)) return { imports: [], checks: [] };
  const local = `${path.basename(path.dirname(path.dirname(path.dirname(facade))))}_${name}`.replace(/\W/g, '_');
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

test('WireFormat<T> equals the generator-emitted JSON type for fixture and example models', async t => {
  const { root } = createModelProject(t, {
    prefix: 'runic-wire-format-',
    name: 'wire-format',
    ttscPlugin: true,
    linkWorkspaceNodeModules: true,
    rootDir: '.',
    // Each example compiles `src/**`, which brings in its codec key file; the
    // ttsc plugin resolves `fromWireFormat<T>`/`toWireFormat<T>` calls through it.
    include: ['fixtures/**/*.ts', 'checks/**/*.ts', 'examples/*/src/generated/models/iobject-plugin-keys.ts'],
    compilerOptions: { noEmit: true },
  });
  const covered: string[] = [];
  const skipped: string[] = [];
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
    try {
      // Models that use an SDK `Money` get a real generated SDK and its manifest.
      const usesSdk = Object.values(sources).some(text => text.includes("from './sdk/"));
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
      // Fixtures for rejected declarations, or needing a project-specific setup, do not generate standalone.
      skipped.push(`${slug}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
      fs.rmSync(projectRoot, { recursive: true, force: true });
      continue;
    }
    writeGeneratedArtifacts(artifacts);
    for (const modelSource of modelSources) {
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

  // Examples carry committed companions and SDKs; check a copy inside the project root.
  const exampleChecks = path.join(root, 'checks');
  for (const example of EXAMPLES) {
    const exampleRoot = path.join(root, 'examples', example);
    fs.cpSync(path.join(workspace, 'examples', example), exampleRoot, {
      recursive: true,
      filter: source => !/[\\/](?:node_modules|\.build|dist)$/.test(source),
    });
    const checkFile = path.join(exampleChecks, `${example}.ts`);
    const imports: string[] = [];
    const checks: WireCheck[] = [];
    const walk = (directory: string): string[] => fs.existsSync(directory)
      ? fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
        ? entry.name === 'node_modules' ? [] : walk(path.join(directory, entry.name))
        : [path.join(directory, entry.name)])
      : [];
    for (const file of walk(exampleRoot).filter(file => MODEL_SOURCE.test(file) && !file.includes('/sdk/'))) {
      const companion = file.replace(MODEL_SOURCE, match => match.replace('.ts', '.generated.ts'));
      if (!fs.existsSync(companion)) continue;
      const result = modelChecks(file, companion);
      const prefix = `${example.replace(/\W/g, '_')}_${path.basename(file).replace(/\W/g, '_')}_`;
      const renamed = result.checks.map(check => ({ label: `${example}/${check.label}`, model: `${prefix}${check.model}`, json: `${prefix}${check.json}` }));
      const sourceNames = result.checks.map(check => check.model);
      const jsonNames = [...new Set(result.checks.map(check => check.json))];
      imports.push(
        `import type { ${sourceNames.map(name => `${name} as ${prefix}${name}`).join(', ')} } from '${importPath(checkFile, file)}';`,
        `import type { ${jsonNames.map(name => `${name} as ${prefix}${name}`).join(', ')} } from '${importPath(checkFile, companion)}';`,
      );
      checks.push(...renamed);
    }
    for (const facade of walk(path.join(exampleRoot, 'sdk', 'models')).filter(file => /\/[A-Z]\w*\.ts$/.test(file))) {
      const result = sdkChecks(facade, checkFile);
      imports.push(...result.imports);
      checks.push(...result.checks.map(check => ({ ...check, label: `${example}/sdk/${check.label}` })));
    }
    if (checks.length === 0) continue;
    fs.mkdirSync(exampleChecks, { recursive: true });
    fs.writeFileSync(checkFile, checkSource(imports, checks));
    covered.push(...checks.map(check => check.label));
  }

  // A collapsed Same/Assert would accept anything; this control must fail.
  fs.writeFileSync(path.join(exampleChecks, 'control.ts'), `${CHECK_PRELUDE}
// @ts-expect-error A Date field is a string on the wire.
export type DateStaysDate = Assert<Same<WireFormat<{ at: Date }>, { at: Date }>>;
// @ts-expect-error any is not a wire type.
export type AnyWire = Assert<NotAny<WireFormat<any>>>;
`);

  t.diagnostic(`covered ${covered.length}: ${covered.join(', ')}`);
  t.diagnostic(`skipped ${skipped.length}: ${skipped.join(' | ')}`);
  // Representative kinds: nested SDK model, SDK model in a union, manifest-backed SDK fields, template literals, tagged booleans, discriminated unions, TSerde, Date in tags, tuples, projections, SDK fields.
  for (const label of [
    'combined/payment-editor.model.ts#TPaymentEditor',
    'union-validation/pets.model.ts#TOwner',
    'serde__iobject-tserde-stringify-parse-convert-declared-fields-in-one-pass/permission.model.ts#TPermissionModel',
    'tag-model-boundaries__date-descriptors-in-contains-and-dependentschemas-validate-model-date-values/calendar.model.ts#TCalendar',
    'model-tuples/tuple.model.ts#TTuple',
    'model-composition__recursive-projections-convert-every-selected-level-without-restoring-omitted/tree.model.ts#TTree',
    'nest-openapi/sdk/nest_openapi_PaymentFields',
    'model-companions__conversion-unions/wallet.model.ts#TWallet',
    'unify-validate__sdk-money-ref-plus-extra-tvalidation-local-tvalidation-and-tserde-share-one-/checkout.model.ts#TCheckout',
    'wire-format/wire-kinds.model.ts#TWireKinds',
  ]) assert.ok(covered.includes(label), `missing equivalence check ${label}`);
  const result = await command(root, process.execPath, [ttsc, '-p', path.join(root, 'tsconfig.json')], { allowFailure: true });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
});

test('toWireFormat<T> returns the emitted JSON type through the ttsc plugin without a cast', async t => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'runic-wire-format-call-',
    name: 'wire-format-call',
    ttscPlugin: true,
    linkWorkspaceNodeModules: true,
  });
  writeModelSources(sourceRoot, {
    'payment-editor.model.ts': `import type { IModel } from '@exprtlabs/codegen/model';
import type { Minimum } from '@exprtlabs/codegen/tags';
import { PaymentEditorBase } from './payment-editor.model.generated.js';

export type TPaymentEditor = IModel<{ amount: number & Minimum<0>; note: string; paidAt: Date }>;

export class PaymentEditor extends PaymentEditorBase {
  public get summary(): string {
    return \`\${this.amount}: \${this.note}\`;
  }
}
`,
  });
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  writeModelSources(sourceRoot, {
    'main.ts': `import { toWireFormat } from '@exprtlabs/codegen/serde';
import { PaymentEditor, type TPaymentEditor } from './payment-editor.model.js';
import type { PaymentEditorJSON } from './payment-editor.model.generated.js';

const editor = new PaymentEditor({ amount: 30, note: 'Lunch', paidAt: new Date('2026-01-02T03:04:05.000Z') });
const wire: PaymentEditorJSON = toWireFormat<TPaymentEditor>(editor);
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
  await compileModelProject(root);
  const result = await command(root, process.execPath, [path.join(root, 'build/main.js')]);
  assert.deepEqual(JSON.parse(result.stdout), {
    wire: { amount: 30, note: 'Lunch', paidAt: '2026-01-02T03:04:05.000Z' },
    paidAt: '2026-01-02T03:04:05.000Z',
  });
});

test('wire output omits optional fields that are absent or undefined', async t => {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: 'runic-wire-format-optional-',
    name: 'wire-format-optional',
    linkWorkspaceNodeModules: true,
  });
  writeModelSources(sourceRoot, {
    'visit.model.ts': `import type { IModel } from '@exprtlabs/codegen/model';
import { SlotBase, VisitBase } from './visit.model.generated.js';

export type TSlot = IModel<{ at: Date; room?: string }>;
export type TVisit = IModel<{
  at: Date;
  note?: string;
  slot?: TSlot;
  detail?: { at: Date; memo?: string };
  window?: Partial<Pick<TSlot, 'at' | 'room'>>;
}>;
export class Slot extends SlotBase {}
export class Visit extends VisitBase {}
`,
  });
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const generated = await import(pathToFileURL(path.join(root, 'build/visit.model.generated.js')).href) as {
    readonly toWireFormatVisit: (value: unknown) => Record<string, unknown>;
    readonly stringifyVisit: (value: unknown) => string;
  };
  const { Visit } = await import(pathToFileURL(path.join(root, 'build/visit.model.js')).href) as {
    readonly Visit: new (values: object) => object;
  };
  const { encodeGeneratedModel } = await import('@exprtlabs/codegen/conversion');
  const at = new Date('2026-01-02T03:04:05.000Z');
  const encoders = [
    ['toWireFormat', generated.toWireFormatVisit],
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
      assert.equal(JSON.stringify(wire), generated.stringifyVisit(visit), `${label}: matches stringify`);
    }
  }
});
