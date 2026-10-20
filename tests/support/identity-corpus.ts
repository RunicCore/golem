import fs from 'node:fs';
import path from 'node:path';
import { fixturePath } from '../fixture-project.js';

/** A fixture file (`from`, relative to tests/fixtures) and where the case project holds it (`to`, relative to the project root). */
export interface IdentityFile { readonly from: string; readonly to: string }

/** One project that the identity test generates and rewrites on both TypeScript versions. */
export interface IdentityCase {
  readonly name: string;
  /** `model`: the model generator, then the rewrite scan. `controller`: the controller generator, then the rewrite scan with the Nest rule. `rewrite`: the rewrite scan alone, over generated companions that are fixtures. */
  readonly kind: 'model' | 'controller' | 'rewrite';
  readonly files: readonly IdentityFile[];
  /** The generation profile's `mobx`. */
  readonly mobx: boolean;
  /** An OpenAPI document (relative to tests/fixtures) whose SDK, generated with the same `mobx`, the project holds under `src/sdk`. */
  readonly sdkSpec?: string;
}

/** One project of a shard: the identity test builds its root, and the child process of one TypeScript version generates and rewrites it. */
export interface IdentityProject {
  readonly name: string;
  readonly kind: IdentityCase['kind'];
  readonly root: string;
  readonly mobx: boolean;
}

/**
 * The files a case leaves in a child's output directory, under the case's own folder:
 * `generated/` holds the generator's files and `rewritten/` the text of each source file the rewrite scan edited, both by path
 * relative to the project root; `diagnostics.txt` holds what the stages reported, one line each, with the root as `<root>`.
 */
export const GENERATED = 'generated';
export const REWRITTEN = 'rewritten';
export const DIAGNOSTICS = 'diagnostics.txt';

/** A case's folder in the output directory: the case name, which may hold slashes, as one folder name. */
export function caseFolder(name: string): string {
  return name.replaceAll('/', '__');
}

const CONTROLLER_PROJECT_SOURCE = 'src/catalog.controller.ts';

/** The five cases that exist since the first identity test. They keep their names, and discovery skips their directories. */
const EXPLICIT: readonly IdentityCase[] = [
  // Each union-order model is generated alone, so the two programs create their literal types in different orders.
  { name: 'union-order-a', kind: 'model', mobx: false, files: modelFiles('models/union-order', ['a.model.ts', 'other.model.ts']) },
  { name: 'union-order-b', kind: 'model', mobx: false, files: modelFiles('models/union-order', ['b.model.ts', 'other.model.ts']) },
  { name: 'generic-default', kind: 'model', mobx: false, files: modelFiles('models/identity/generic-default', ['codecs.ts', 'blob.model.ts']) },
  { name: 'intersection', kind: 'model', mobx: false, files: modelFiles('models/identity/intersection', ['parts.model.ts']) },
  {
    name: 'controller',
    kind: 'controller',
    mobx: false,
    files: [{ from: 'controllers/controller/generates-a-static-nest-document-with-evaluated-routes-inheritance-uri-version/controller.ts', to: CONTROLLER_PROJECT_SOURCE }],
  },
];

/** The groups under tests/fixtures/models whose claim directories hold models. `identity` holds the cases that exist only for this test. */
const MODEL_GROUPS = [
  'identity', 'model-tags', 'model-composition', 'tag-model-boundaries', 'model-tuples', 'model-companions', 'model-generator',
  'constraint-callback-composition', 'constraint-parity', 'constraint-portability', 'projection-integration', 'multi-tag',
] as const;

/** The cases whose model is generated with `mobx: true`; every other case uses `mobx: false`. */
const MOBX_CASES: ReadonlySet<string> = new Set([
  'model-composition/model-composition-item-model',
]);

/** Directories under tests/fixtures/wire-format that hold an OpenAPI document get its SDK; the others are plain model claims. */
const SDK_SPEC = /\.ya?ml$/;

/**
 * The cases whose claim is a rejection, each with a fragment of the message it claims: generation or the rewrite scan ends in an error,
 * and the diagnostics file holds a `generate error` or `rewrite error` line with the fragment. Every other case must write no such line,
 * and a setup fault in a rejection case (a missing file, an unresolved module) does not carry its fragment, so none can pass as the claim.
 */
export const EXPECTED_REJECTIONS: Readonly<Record<string, string>> = {
  'model-composition/a-projected-child-applies-the-containing-model-allowany-policy': 'RUNM1011: Model TContainer contains any. Replace it with a concrete type, or allow it with',
  'model-composition/anonymous-nested-imodel-declarations-fail-with-an-actionable-diagnostic': 'RUNM1053: Nested IModel definitions need a named, exported declaration',
  'model-composition/generic-model-templates-require-a-concrete-named-declaration': 'RUNM1057: IModel declarations must have concrete fields',
  'model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts': 'RUNM1052: Root IModel unions are unsupported',
  'controller/does-not-treat-a-project-local-string-function-as-a-swagger-primitive-construc': 'NEST1503: Swagger property value type conflicts',
  'controller/keeps-nest-runtime-status-authoritative-over-apinocontentresponse': 'NEST1311: Swagger success response status 204 conflicts',
  'controller/rejects-a-swagger-schema-that-conflicts-with-an-authoritative-imodel-wire-cont': 'NEST1503: Swagger schema at response.200.application/json.properties.id.type is "number"',
  'controller/rejects-a-swagger-success-status-that-contradicts-nest-post-runtime-status': 'NEST1311: Swagger success response status 200 conflicts',
  'controller/rejects-conflicting-static-routes-with-a-structured-diagnostic': 'NEST1306: Route GET /api/conflicts/same is declared more than once',
  'controller/rejects-stream-responses-without-explicit-swagger-content': 'NEST1310: File, stream, and Observable responses require explicit Swagger content',
  'controller/rejects-unresolved-local-component-references-in-raw-swagger-response-metadata': 'NEST1505: OpenAPI metadata references missing local schema component',
};

/** A fixture directory that discovery finds and leaves out, with the one reason it cannot run on its own. */
const EXCLUDED: Readonly<Record<string, string>> = {
  'model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases': 'needs its own tsconfig: the `#generated/*` path alias',
  'model-generator/manifest-identity': 'needs an SDK manifest that is not one of the two SDK cases',
  'model-companions/conversion-unions': 'needs an SDK manifest that is not one of the two SDK cases',
  'model-companions/missing-manifest': 'needs an SDK manifest that is not one of the two SDK cases',
  'model-companions/public-generation-compiles-and-executes-conversion-and-rest-tuple-behavior': 'needs an SDK manifest that is not one of the two SDK cases',
  'constraint-callback-composition/handwritten-child-parent': 'not self-contained: its test adds the sibling files that the model imports',
  'constraint-callback-composition/nested-value-callbacks': 'not self-contained: its test adds the sibling files that the model imports',
  'constraint-portability/constraint-portability-a-model': 'not self-contained: its test adds the sibling files that the model imports',
  'model-tags/generic-aliases-preserve-concrete-local-model-identity-for-nested-conversion': 'not self-contained: its test adds the sibling files that the model imports',
  'wire-format/nested-sdk': 'its SDK claim needs the SDK generator, which loads no TypeScript',
  'model-companions/serde-edit': 'not self-contained: its test adds the sibling files that the model imports',
};

/** Model cases that stay in the identity corpus and leave the one TypeScript 6 compile, each with its reason. */
const COMPILE_EXCLUDED: Readonly<Record<string, string>> = {
  'model-tuples/readonly': 'sets exactOptionalPropertyTypes and noUncheckedIndexedAccess in its own compilerOptions, which the shared compile does not hold',
};

function modelFiles(directory: string, names: readonly string[]): IdentityFile[] {
  return names.map(name => ({ from: `${directory}/${name}`, to: `src/${name}` }));
}

function entries(directory: string): fs.Dirent[] {
  return fs.readdirSync(fixturePath(directory), { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Every `.ts` file under `directory`, as paths relative to it. */
function sourcesUnder(directory: string, relative = ''): string[] {
  return entries(path.posix.join(directory, relative)).flatMap(entry => {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) return sourcesUnder(directory, child);
    return entry.name.endsWith('.ts') ? [child] : [];
  });
}

function placed(directory: string, root: string, relatives: readonly string[]): IdentityFile[] {
  return relatives.map(relative => ({ from: `${directory}/${relative}`, to: `${root}/${relative}` }));
}

/** The directory's sources under `src/`: the folder `src/` keeps its place, any other file goes to `src/`. */
function claimFiles(directory: string): IdentityFile[] {
  const hasSource = entries(directory).some(entry => entry.isDirectory() && entry.name === 'src');
  return hasSource
    ? placed(`${directory}/src`, 'src', sourcesUnder(`${directory}/src`))
    : placed(directory, 'src', sourcesUnder(directory));
}

function modelClaims(group: string): IdentityCase[] {
  const directory = `models/${group}`;
  return entries(directory).flatMap((entry): IdentityCase[] => {
    if (entry.isDirectory()) {
      const files = claimFiles(`${directory}/${entry.name}`);
      return files.some(file => file.to.endsWith('.model.ts')) ? [{ name: `${group}/${entry.name}`, kind: 'model', mobx: false, files }] : [];
    }
    // A model file beside the claim directories is a claim of its own, with the files of the group that it imports.
    return entry.name.endsWith('.model.ts')
      ? [{ name: `${group}/${entry.name.slice(0, -'.model.ts'.length)}`, kind: 'model', mobx: false, files: placed(directory, 'src', withLocalImports(directory, [entry.name])) }]
      : [];
  });
}

function wireClaims(): IdentityCase[] {
  return entries('wire-format').filter(entry => entry.isDirectory()).map((entry): IdentityCase => {
    const directory = `wire-format/${entry.name}`;
    const spec = entries(directory).find(file => SDK_SPEC.test(file.name));
    return {
      name: directory,
      kind: 'model',
      mobx: false,
      files: [...placed(directory, 'src', sourcesUnder(directory)), { from: 'wire-format/wire-assert.ts', to: 'src/wire-assert.ts' }],
      ...(spec ? { sdkSpec: `${directory}/${spec.name}` } : {}),
    };
  });
}

function publicModelLayout(): IdentityCase {
  return { name: 'public-model-layout', kind: 'model', mobx: false, files: placed('public-model-layout/src', 'src', sourcesUnder('public-model-layout/src')) };
}

function controllerClaims(): IdentityCase[] {
  const directory = 'controllers/controller';
  return entries(directory).filter(entry => entry.isDirectory()).map((entry): IdentityCase => {
    const claim = `${directory}/${entry.name}`;
    return {
      name: `controller/${entry.name}`,
      kind: 'controller',
      mobx: false,
      files: sourcesUnder(claim).map(relative => ({ from: `${claim}/${relative}`, to: relative === 'controller.ts' ? CONTROLLER_PROJECT_SOURCE : `src/${relative}` })),
    };
  });
}

const MODEL_PAIR = /\.model\.(?:generated\.)?ts$/;

/** The files in `start` and, for each, the files of `directory` that it imports by a relative `.js` specifier and those import in turn. */
function withLocalImports(directory: string, start: readonly string[]): string[] {
  const wanted = new Set(start);
  const visit = (relative: string): void => {
    const text = fs.readFileSync(fixturePath(`${directory}/${relative}`), 'utf8');
    for (const [, specifier] of text.matchAll(/from '(\.\.?\/[^']+)\.js'/g)) {
      const imported = `${path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier!))}.ts`;
      if (wanted.has(imported) || !fs.existsSync(fixturePath(`${directory}/${imported}`))) continue;
      wanted.add(imported);
      visit(imported);
    }
  };
  start.forEach(visit);
  return [...wanted].sort();
}

/** The files a rewrite use file needs: the payment model that every rewrite project holds, and what the two import. */
function rewriteFiles(useFile: string): IdentityFile[] {
  return [
    ...placed('rewrite', 'src', withLocalImports('rewrite', [useFile, 'payment.model.ts'])),
    { from: 'rewrite/codec-keys.json', to: '.golem/codec-keys.json' },
  ];
}

function rewriteClaims(): IdentityCase[] {
  return entries('rewrite')
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !MODEL_PAIR.test(entry.name))
    .map((entry): IdentityCase => ({ name: `rewrite/${entry.name.slice(0, -'.ts'.length)}`, kind: 'rewrite', mobx: false, files: rewriteFiles(entry.name) }));
}

function discover(): IdentityCase[] {
  const explicitDirectories = new Set(EXPLICIT.flatMap(item => item.files.map(file => path.posix.dirname(file.from))));
  const found: IdentityCase[] = [
    ...MODEL_GROUPS.flatMap(modelClaims),
    ...wireClaims(),
    publicModelLayout(),
    ...controllerClaims(),
    ...rewriteClaims(),
  ].filter(item => !item.files.some(file => explicitDirectories.has(path.posix.dirname(file.from))));
  const names = new Set(found.map(item => item.name));
  const stale = Object.keys(EXCLUDED).filter(name => !names.has(name));
  if (stale.length > 0) throw new Error(`The identity corpus excludes cases that discovery does not find: ${stale.join(', ')}`);
  return found.filter(item => !(item.name in EXCLUDED)).map(item => ({ ...item, mobx: MOBX_CASES.has(item.name) }));
}

/** The explicit cases, then the discovered ones. Read once, with synchronous calls, so a test file registers one test for each case when it loads. */
export const IDENTITY_CASES: readonly IdentityCase[] = (() => {
  const cases = [...EXPLICIT, ...discover()];
  const duplicate = cases.find((item, index) => cases.findIndex(other => other.name === item.name) !== index);
  if (duplicate) throw new Error(`The identity corpus holds the case ${duplicate.name} twice`);
  const unknownMobx = [...MOBX_CASES].filter(name => !cases.some(item => item.name === name));
  if (unknownMobx.length > 0) throw new Error(`The identity corpus generates cases with mobx that it does not hold: ${unknownMobx.join(', ')}`);
  const unknownRejections = Object.keys(EXPECTED_REJECTIONS).filter(name => !cases.some(item => item.name === name));
  if (unknownRejections.length > 0) throw new Error(`The identity corpus expects rejections from cases that it does not hold: ${unknownRejections.join(', ')}`);
  const unknown = Object.keys(COMPILE_EXCLUDED).filter(name => !cases.some(item => item.name === name && item.kind === 'model'));
  if (unknown.length > 0) throw new Error(`The identity corpus leaves model cases out of the compile that it does not hold: ${unknown.join(', ')}`);
  return cases;
})();

/** The model cases of the corpus that the one TypeScript 6 compile checks. */
export function isCompiled(item: IdentityCase): boolean {
  return item.kind === 'model' && !(item.name in COMPILE_EXCLUDED);
}

/** The cases of shard `index` of `count`: every `count`-th case, so each shard holds the same mix of kinds. */
export function shardOf(cases: readonly IdentityCase[], count: number, index: number): IdentityCase[] {
  return cases.filter((_, position) => position % count === index);
}
