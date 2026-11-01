# Generator and tool API

Register a golem.yaml block from your own package, call a generator from your own tool, and apply the files it returns, with the tool subpaths of `@exprtlabs/golem`.

Application projects use the [CLI](/reference/cli), which writes files, tracks
the files each job wrote and runs watch mode.

- Providers return file contents. They do not write files.
- Every generator context takes absolute paths and a `profile`.
- `watchInputs` lists the paths a build tool watches after generation.
- A provider reports `apiVersion` `1`. The CLI rejects another version.
- A package that registers a block ([below](#register-a-block)) implements a plan entry and a generator entry with `generator-api` alone. It can write source models, and the models job makes their codecs.

Usage: [Run the generators from code](/guide/generator-api) and [Write a generator](/guide/generators).

## Register a block {#register-a-block}

A golem package is an npm package whose `package.json` has a `golem` field. The field registers one top-level block of `golem.yaml`. The package owns the block: it validates every key and declares the jobs. Golem knows no package by name.

```json
{
  "name": "@acme/golem-events",
  "exports": { "./plan": "./dist/plan.js", "./generator": "./dist/generator.js", "./tag": "./dist/tag.js" },
  "golem": {
    "apiVersion": 2,
    "block": "events",
    "plan": "./plan",
    "generator": "./generator",
    "extensions": { "tag": "./tag" },
    "schema": "./golem-schema.json"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `apiVersion` | Yes | `2`. Golem stops on a package with another registration version. |
| `block` | Yes | The `golem.yaml` key that the package owns. It is not a [root key](/reference/config#root-keys), and no other installed package registers it. |
| `plan` | For a job | A subpath of `exports`. The light entry: it reads the block and declares the jobs. |
| `generator` | For a job | A subpath of `exports`. The heavy entry: it runs a job and returns files. |
| `extensions` | No | The extensions that the block can turn on: a name for each, with a subpath, or `{ "entry": "./sub", "profile": true }`. |
| `schema` | No | A JSON Schema file of the block, a path in the package. Golem merges it into `.golem/schema.json`. |

A subpath must be a key of `exports` that Node resolves from the folder of `golem.yaml`. Golem finds the package when a `package.json` of the project lists it, or when it is the nearest `package.json` to `golem.yaml` ([blocks](/reference/config#blocks)).

Golem also checks the version of a package that pins `@exprtlabs/golem` to its own exact version, as it does for its own packages. A package with run-time code lists `@exprtlabs/golem` as a peer dependency, so the app holds one copy.

### The plan entry

The `plan` module exports `plan`. It imports no TypeScript, no generator code and no `yaml`, so it takes only types from `@exprtlabs/golem/generator-api`. Name a contract by its text: `ModelBoundary` or `CodecsHost`.

```ts
import path from 'node:path';
import type { GolemPlanEntry } from '@exprtlabs/golem/generator-api';

export const plan: GolemPlanEntry = {
  declare({ directory, block, profile }) {
    const { output } = (block ?? {}) as { output?: unknown };
    if (typeof output !== 'string') throw new TypeError('events.output must be a string.');
    const folder = path.resolve(directory, output);
    return [{
      facts: { id: 'events', outputs: [{ path: folder, kind: 'folder' }], ownedRoots: [], inputFiles: [], inputFolders: [], readsProgram: false, provides: [], needs: [], hooks: [], watch: [] },
      options: { output: folder, profile },
    }];
  },
};
```

Golem calls the entry in two passes:

1. `declare(context)` validates the whole block and returns its jobs. Each job has `facts` and `options`, and, when it provides a contract, a `provided` value for each.
2. `link(job, { needed, consumers })` is optional. It gets the value of each contract the job needs, and the facts of the jobs that need a contract the job provides. It returns `facts` and `options`, and cannot change the `id`.

| `PlanContext` field | Meaning |
| --- | --- |
| `configFile`, `directory` | The `golem.yaml` file and its folder, absolute. Resolve the paths of the block from `directory`. |
| `tsconfig` | The project's tsconfig, absolute. |
| `profile` | The root keys `validation`, `allowAny` and `unknownFormats`, resolved, with the options of the extensions that you flag `profile: true`. |
| `exact` | The root key `exact`. Omitted when it is not set. |
| `block` | The value under your block name, as parsed, `extensions` included. Accept the `extensions` key when you validate it: golem reads that key itself. |
| `onInput` | Call it with each local path you read or resolve, before you touch it. |

Golem passes the `options` of a job to its generator as they are. They must be an object. Golem compares them as stable JSON, so a changed option runs the job again.

### What a job declares {#job-facts}

The facts of a job drive the [job order](/reference/config#job-order) and the checks that golem makes. A fact names no package. Every path is absolute and canonical.

| Fact | Meaning |
| --- | --- |
| `id` | A name unique in one `golem.yaml`. Golem prints it in every message. |
| `outputs` | Destinations that only this job writes, each a `file` or a `folder`. They never overlap another job, and none holds `golem.yaml` or `.golem/`. Add `importedByApp: true` when the app imports the files: the output then lies in the tsconfig folder. |
| `ownedRoots` | Folders the job owns but does not claim alone. They lie in the tsconfig folder. |
| `scanRoots` | Folders the job only reads and scans. They exist and lie in the tsconfig folder. |
| `inputFiles`, `inputFolders` | What the job reads. A job that reads the output of another job runs after it. |
| `readsProgram` | `true` when the job opens the app's TypeScript program. This decides its place in the order and which later outputs it sees. |
| `provides`, `needs`, `wants` | Contracts, below. |
| `hooks` | Names of the hooks the job offers to extensions. |
| `watch` | Where a new file runs the job: a folder, or the folders the job owns, scans or reads, and the file-name `suffixes`. An empty list means none. |

A job that breaks a rule stops loading and the message names the jobs: a cycle of reads, overlapping outputs, an output in `golem.yaml` or `.golem/`, a root or an app-imported output outside the tsconfig folder, or a contract problem.

### Contracts {#contracts}

A contract is a typed value that one job provides and others use. Golem knows two by name. Any package can provide them.

| Contract | Value | Used for |
| --- | --- | --- |
| `ModelBoundary` | `ModelBoundaryValue`: the models `root`, `directory`, `output` and `suffixes` | Golem's rewrite and the docs jobs find the models of the app. It is optional: without a provider, the rewrite serves SDK models only. |
| `CodecsHost` | `CodecsHostValue`: `modelsOutput` and `configDirectory` | An SDK in `mode: golem` imports the codecs file that its provider writes. `sdkCodecsFile` names it. |

- A job lists a contract in `provides` and returns its value in `provided`, in the first pass.
- A job lists a contract in `needs` to get its value in `link`. A needed contract with no provider stops loading and names the contract.
- A job lists a contract in `wants` to get the value when exactly one job provides it. No provider is no error.
- At most one job provides a contract. Two providers stop loading.

### The generator entry

The `generator` module exports `apiVersion` (`1`) and `generate(context)`, as in [Generator modules](#generator-modules). The context is the `options` of the job from the plan entry, plus the host context:

| Field | Meaning |
| --- | --- |
| `onInput` | Call it with each local file path before you read it. Golem skips a job whose inputs did not change. |
| `session` | `retain` and `share` keep a resource, such as a compiler, across runs. |
| `programView` | For a job with `readsProgram: true`. `stubbedProviders` and `laterOutputs` say what the program leaves out or stubs of the jobs that run later. |
| `hooks` | For a job that offers hooks: the participants of the extensions that fill each, in the order of `golem.yaml`. |
| `manifestInputs` | The `model-manifest.json` files that earlier jobs wrote. |

Each artifact starts with `/* Generated by <package>. Do not edit. */`, with the name of your package. A space, a line end or a full stop must follow the name.

### Offer a hook {#hooks}

A hook is a named place where extensions add code to a job. The job that offers the hook defines its contract, exports its name as a constant, and owns the type of its participant. Golem only routes the participants.

- List the hook name in `facts.hooks`.
- Call each participant through `fill.use`: `context.hooks['acme.note'].map(fill => fill.use(note => note({ options: fill.options })))`.
- A participant that throws stops the run, and the message names the package of the extension. This is a fault in that package.
- An extension that fills a hook that no job of the `golem.yaml` offers stops loading. The message lists the hooks offered.
- Golem runs the job again when the code or options of an extension on its hooks change.

### Write an extension {#extensions}

An extension has no output. It plugs into the rewrite or into a hook of a job. The user turns it on under `extensions:` in your block, by name, with its options (`{}` for none):

```yaml
events:
  output: src/events
  extensions:
    tag: {}
```

The entry is a module that exports `extension`. Golem loads it when a build tool or the CLI starts, after the host picks the project's TypeScript, and it never loads an extension that the block does not name.

```ts
import type { GolemExtension } from '@exprtlabs/golem/generator-api';

export const extension: GolemExtension = {
  rewrite({ ts, checker, file, options, core }) {
    return { edits: [], reads: [], diagnostics: [] };
  },
  hooks: { 'acme.note': ({ options }) => 'a line of text' },
};
```

`rewrite` runs for each source file in `golem check`, `golem build`, the Vite plugin, the esbuild plugin and the Node loader alike. It gets the TypeScript seam `ts`, so it never picks TypeScript itself.

| Input | Meaning |
| --- | --- |
| `ts`, `checker`, `file` | The TypeScript API of the project, its type checker and the source file. |
| `root` | The project root, the folder of the tsconfig. |
| `options` | The value under the extension's name in `golem.yaml`. |
| `codecKeys` | `idFor(filename, name)` and `moduleOf(id)`, from `.golem/codec-keys.json`. |
| `boundary` | The `ModelBoundary` value. `undefined` without a provider. |
| `modelClasses()` | How many classes register for each model, by model key. |
| `core` | Helpers: `importName(node, name, from)`, `loadCodecModule(id)`, `codecIdOf(symbol)`, `isGolemModel(symbol)` and `locate(node, code, message)`. |

| Result | Meaning |
| --- | --- |
| `edits` | Text edits `{ start, end, expect, text }`. Golem checks each against the file. No edit may overlap an edit of core or of another extension: the build stops with [`RUNM1091`](/reference/diagnostics#runm1091). |
| `reads` | Absolute files the extension read besides the source. A change to one scans the file again. |
| `diagnostics` | Diagnostics for the user, with your own codes. |

Set `"profile": true` on an extension in `golem.extensions` when its options change generated code. Golem then records the options of that extension in `profile.extensions` of each manifest, by package name, as `golem.yaml` writes them. Every option of such an extension must change generated code and must have no silent default.

### What stops loading {#registration-failures}

| Case | Result |
| --- | --- |
| A block that no installed package registers | Loading stops and lists the installed golem packages and their blocks. |
| Two packages register one block | Loading stops and names both. |
| A package with another `apiVersion` | Loading stops and names the package. |
| A block turns on an extension that the package does not register | Loading stops and lists the extensions that it registers. |
| Two jobs with one `id` | Loading stops and names both packages. |
| An extension or a plan entry that does not load | Loading stops and names the package and the file. |
| An extension that throws | The run stops and names the package. |

## Shared contracts

```ts
import type {
  GolemDiagnostic,
  GolemProfile,
  GolemProvider,
  GolemResult,
} from '@exprtlabs/golem/generator-api';

interface GolemProfile {
  readonly mobx: boolean;
  /** `true` checks every rule, `'sanity'` the JSON shape only, `false` nothing. */
  readonly validation: boolean | 'sanity';
  readonly allowAny?: boolean;
  /** `error` (the default) fails generation on a schema format that golem does not implement; `warn` skips its check. */
  readonly unknownFormats?: 'warn' | 'error';
}

interface GolemArtifact {
  readonly path: string;
  readonly content: string;
}

interface GolemResult {
  readonly artifacts: readonly GolemArtifact[];
  readonly manifestPaths: readonly string[];
  readonly watchInputs: readonly string[];
  readonly diagnostics?: readonly GolemDiagnostic[];
}

enum GolemDiagnosticSeverity {
  Error = 'error',
  Warning = 'warning',
}

interface GolemDiagnostic {
  readonly code: string;
  readonly severity: GolemDiagnosticSeverity;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly path?: string;
}

type InputObserver = (absolutePath: string) => void;

interface GeneratorSession {
  retain<Resource extends Disposable>(key: string, create: () => Resource): Resource;
}

interface GolemProvider<Context> {
  readonly apiVersion: 1;
  generate(context: Context): GolemResult | Promise<GolemResult>;
}
```

| Export | Signature | Behavior |
| --- | --- | --- |
| `resolveProfile` | `(profile: GolemProfile): ResolvedGolemProfile` | Applies the defaults `allowAny: false` and `unknownFormats: 'error'` and returns a frozen profile. Throws `TypeError` for an unknown key, a `mobx` or `allowAny` that is not a boolean, a `validation` that is not `true`, `false` or `'sanity'`, or an `unknownFormats` other than `'warn'` or `'error'`. |
| `GolemProvider` | `{ apiVersion: 1; generate(context) }` | The shape each generator module exports. |
| `GolemDiagnosticSeverity` | `Error`, `Warning` | Severity of a returned diagnostic. |
| `GolemPlanEntry` | `{ declare(context); link?(job, contracts) }` | The shape each plan module exports as `plan` ([the plan entry](#register-a-block)). |
| `GolemGeneratorEntry` | `GolemProvider<Options & GeneratorHostContext>` | The shape of the generator module of a job. Each artifact it returns must start with the ownership header for its package, `/* Generated by <package>. Do not edit. */`. A space, a line end or a full stop must follow the package name. |

## Build tool rules {#build-tool-rules}

- Every generator applies `resolveProfile` to the profile you pass.
- `profile.validation` is a level, not a flag. `'sanity'` still writes validators, so test `profile.validation === false` for off. A model may set a lower level than the profile ([Validation profiles](/reference/config#validation-profiles)).
- Show returned diagnostics to the user. Their codes are in [Diagnostics](/reference/diagnostics).
- A generator reports a failure as an exception or as a result that carries an `Error` diagnostic. Treat both as a failed run. The CLI stops the job.
- `onInput` runs before each local read or existence check, including for a missing path.
- The CLI skips a job whose recorded inputs did not change since its last run. It learns an input when the generator calls `onInput`. A file that the generator returns in `watchInputs` without calling `onInput` is recorded when the generator returns. If the file changed during the run, the next run runs the generator again. A directory that the generator returns without announcing it makes the generator run every time. Call `onInput` for each file you read, so golem records it at the read.
- Pass the same `session` to repeated `generate()` calls of the model or controller generator to keep its TypeScript compiler running between calls. The session owner disposes the retained resources.
- Without a session, each call starts and closes its own compiler.

Usage: [Run the generators from code](/guide/generator-api#check-the-result).

## `@exprtlabs/golem/generator-api` {#generator-api}

```ts
import type { GolemProvider, ModelContext } from '@exprtlabs/golem/generator-api';
```

The subpath is the extension API. It exports the contracts above and the types `GolemExtension`, `RewriteParticipant`, `RewriteParticipantInput`, `RewriteParticipantResult`, `RewriteCore`, `ModelContext`, `OpenApiContext`, `ControllerContext`, `ControllerModels`, `ControllerTag`, `ControllerUriVersioning`, `ControllerUriVersioningType`, `GolemDiagnosticCode`, `ResolvedGolemProfile` and `SourceDiscoveryOptions`. It follows semver, and an extension package keeps its own version.

| Export | Signature | Behavior |
| --- | --- | --- |
| `stableJson` | `(value): string` | Indented JSON text with the keys sorted at every depth. |
| `stableValue` | `(value): unknown` | A copy of the value with sorted keys. |
| `compareText` | `(left, right): number` | Orders text by UTF-16 code unit, so output does not depend on the locale. |
| `isInsideDirectory` | `(directory, filename): boolean` | `true` when `filename` is `directory` or lies inside it. |
| `discoverSources` | `(root, options: SourceDiscoveryOptions): string[]` | Sorted, unique sources below `root`. Skips dot entries and `node_modules`. A missing root yields none. |
| `parseYamlFile` | `(text, filename, options?): unknown` | Parses YAML text that came from `filename`. Throws a `YamlFileError` for invalid YAML. |
| `YamlFileError` | `class extends Error` | Its message starts with `<file>:<line>:<column>`, the file relative to the working directory. Its `cause` is the parser's error. |

## `@exprtlabs/golem/manifest` {#manifest}

```ts
import { discoverModelManifests, readModelManifest } from '@exprtlabs/golem/manifest';
```

An OpenAPI job writes `model-manifest.json` beside its SDK. A model job reads it to use the SDK types in your declarations.

| Member | Signature | Behavior |
| --- | --- | --- |
| `discoverModelManifests` | `(root = process.cwd(), onInput?): string[]` | Sorted absolute paths of `model-manifest.json` files below `<root>/src`, skipping `dist` and `build`. |
| `readModelManifest` | `(filename: string, onInput?): ModelManifest` | Reads and checks one manifest. Throws with the file name when it is unreadable or invalid. |
| `validateModelManifest` | `(manifest: unknown, filename?): ModelManifest` | Checks a parsed manifest. |
| `ModelManifest` | `{ profile, models, mode?, … }` | The generation profile, one entry in `models` for each schema, and, in a `golem` SDK, the schema graph that the model job compiles. |
| `MODEL_MANIFEST_FILENAME` | `'model-manifest.json'` | The file name. |

## `@exprtlabs/golem/rewrite` {#rewrite}

```ts
import { applyRewrites } from '@exprtlabs/golem/rewrite';
```

Every [build tool](/guide/build) scans each TypeScript file it compiles or loads with your project's own TypeScript. Then it edits the file's text before the types are stripped. The edits are:

| Call | Becomes |
| --- | --- |
| `stringify<T>(value)` | the generated `stringify` for `T` |
| `parse<T>(text)` | the generated `parse` for `T`, constructing your class when `T` is a class |
| `validate<T>(value)` | the generated `validate` for `T` |
| `assertValue<T>(value)` | the generated `assert` for `T` |
| `toWireFormat<T>(value)` | the generated `toWireFormat` for `T` |
| `fromWireFormat<T>(wire)` | the generated `fromWireFormat` for `T`, constructing your class when `T` is a class |

When a source of the project imports `@exprtlabs/golem/nest`, the rewrite also marks `@Body()` and `@Query()` parameters that take a model, and handlers that return a model, so that `NestModelInterceptor` can convert them. `golem build`, [`loader`](/reference/runtime-api#loader), [`vite`](/reference/runtime-api#vite) and [`esbuild`](/reference/runtime-api#esbuild) use this subpath to apply their edits.

| Member | Signature | Behavior |
| --- | --- | --- |
| `applyRewrites` | `(text: string, rewrite: FileRewrite, file?: string): { code: string; map: SourceMapV3 }` | Applies the edits and the imports they need to the file's `text`, and returns the new `code` with its source `map`. Offsets are UTF-16 units of the text without a leading byte order mark, which the output keeps. The map has one source, named `''`. Set `sources` on it when you know the file name. Throws an error that names `file` and the line when an edit is out of range, overlaps another edit, or no longer matches the text it expects. |
| `REWRITE_IMPORT_PREFIX` | `'__golem_'` | The prefix of the names that the rewrite imports. Each name is imported as `__golem_<name>`, so edit text cannot clash with an import of your file. |

Types: `FileRewrite` (`{ edits, imports, importsAt }`, where `importsAt` is the offset in the text where the imports go: after a shebang and the directive prologue, such as `'use client'`), `RewriteEdit` (`{ start, end, expect, text }`) and `RewriteImport` (`{ from, names }`).

## Generator modules {#generator-modules}

Each module exports `apiVersion` (`1`) and `generate`. Usage: [Run the generators from code](/guide/generator-api).

| Module | Signature | Result |
| --- | --- | --- |
| `@exprtlabs/golem-ts-openapi/generator` | `generate(context: ControllerContext): Promise<TsToOpenApiResult>` | The first artifact is the OpenAPI document. A second artifact is a generated file that the rewrite reads. `manifestPaths` is empty. |
| `@exprtlabs/golem-openapi/generator` | `generate(context: OpenApiContext): Promise<OpenApiGenerationResult>` | The SDK files. `manifestPaths` holds the SDK's `model-manifest.json`. |
| `@exprtlabs/golem-model/generator` | `generate(context: ModelContext): GolemModelResult` | The generated model files. |

## `ControllerContext` {#controllercontext}

The context of the generator that writes an OpenAPI document from controllers. Usage: [Generate OpenAPI from controllers](/guide/generator-api#generate-openapi-from-controllers).

| Field | Required | Default | Effect |
| --- | --- | --- | --- |
| `root` | Yes | — | Existing project directory. |
| `output` | Yes | — | The `.json`, `.yaml` or `.yml` file to generate. |
| `info` | Yes | — | OpenAPI `info` object. |
| `profile` | Yes | — | `GolemProfile`. |
| `exact` | No | `true` | Default for the `exact` option of a model that sets none. `golem.yaml` passes its root `exact`. |
| `models` | No | omitted | The `model` block of the same `golem.yaml`: `root`, `directory` and `output` as absolute paths, and `suffixes`. With it, a shared model of the app, or a class that extends the generated base class of one, matches its model. `golem.yaml` passes it. |
| `sources` | No | files that end in `suffixes` below `<root>/src` | Non-empty list of controller files. |
| `suffixes` | No | `['.controller.ts']` | File-name endings that make a file below `<root>/src` a controller source. |
| `openapiVersion` | No | `'3.2.0'` | `'3.2.0'` or `'3.1.2'`. |
| `servers`, `securitySchemes`, `tags`, `globalPrefix`, `uriVersioning`, `maxResultBytes` | No | omitted | Same as the [`docs` keys](/reference/config#ts-openapi-block). |
| `onInput` | No | omitted | Called with each path before it is read. |
| `session` | No | omitted | Keeps the compiler running across calls. |

Diagnostic source locations are not copied into the OpenAPI document.

Example:

```ts
import { generate } from '@exprtlabs/golem-ts-openapi/generator';

const result = await generate({
  root: '/absolute/app/backend',
  output: '/absolute/app/api/payments.yaml',
  info: { title: 'Payments API', version: '1' },
  profile: { mobx: false, validation: true },
});

console.log(result.artifacts[0]?.path); // /absolute/app/api/payments.yaml
```

## `OpenApiContext` {#openapicontext}

The context of the SDK generator. Usage: [Generate an OpenAPI SDK](/guide/generator-api#generate-an-openapi-sdk).

| Field | Required | Default | Effect |
| --- | --- | --- | --- |
| `input` | Yes | — | OpenAPI document, JSON or YAML. |
| `output` | Yes | — | SDK directory. |
| `profile` | Yes | — | `GolemProfile`. |
| `name` | No | the document's `info.title`, else `Api` | Prefix of the client name, such as `PaymentsClient`. |
| `dates` | No | `'date'` | `'temporal'` maps date and date-time strings to Temporal types ([`dates`](/reference/config#openapi-ts-block)). |
| `mode` | No | `'standalone'` | `'standalone'` writes an SDK that carries its own checks, conversions and runtime. `'golem'` writes types and the client only, and leaves checks and conversions to the model job ([`mode`](/reference/config#openapi-ts-block)). |
| `codecsFile` | With `mode: 'golem'` | omitted | The absolute path of the file that the model job writes for this SDK. The operation modules import the operation codecs from it. `golem.yaml` sets it for you. |
| `allowRemoteRefs` | No | `false` | Reads HTTPS `$ref` documents when `true`. |
| `remoteHosts` | No | `[]` | Hosts remote references may use. Required with `allowRemoteRefs`. |
| `maxRefBytes` | No | `5242880` | Maximum bytes read from one referenced document. |
| `maxRefDocuments` | No | `256` | Maximum referenced documents, local ones included. |
| `refTimeoutMs` | No | `10000` | Timeout of each remote read, in milliseconds. |
| `onInput` | No | omitted | Called with each local path before it is read. |

- `manifestPaths` holds the SDK's `model-manifest.json`. A model job reads it to know the SDK types.
- A `standalone` SDK carries its checks and conversions. Its manifest lists the schemas of the SDK.
- A `golem` SDK carries none. Its manifest holds the schema graph as data, and the model job compiles the checks and conversions of the SDK with your models.
- A model job that reads a manifest from an older release fails and asks you to generate the SDK again.

Example:

```ts
import { apiVersion, generate } from '@exprtlabs/golem-openapi/generator';

const result = await generate({
  input: '/absolute/app/api.yaml',
  output: '/absolute/app/sdk',
  name: 'Payments',
  profile: { mobx: false, validation: true },
});

console.log(apiVersion, result.artifacts.map(artifact => artifact.path));
```

### `writeSdk` and `loadValidatedDocument` {#writesdk}

Both are exports of `@exprtlabs/golem-openapi/generator`. Usage: [Start from a loaded document](/guide/generator-api#start-from-a-loaded-document).

```ts
function writeSdk(
  document: unknown,
  options: { readonly output: string; readonly name?: string; readonly profile: GolemProfile; readonly dates?: 'date' | 'temporal'; readonly mode?: 'standalone' | 'golem'; readonly codecsFile?: string },
): GolemResult;

function loadValidatedDocument(filename: string, options?: ReferenceResolutionOptions): Promise<unknown>;
```

- `loadValidatedDocument` reads and checks the document and bundles its references. `options` takes the reference fields of `OpenApiContext` and `onInput`.
- `writeSdk` reads no files and returns empty `watchInputs`.

Example:

```ts
import { loadValidatedDocument, writeSdk } from '@exprtlabs/golem-openapi/generator';

const document = await loadValidatedDocument('/absolute/app/api.yaml');
const result = writeSdk(document, {
  output: '/absolute/app/sdk',
  profile: { mobx: false, validation: true },
});
```

## `ModelContext` {#modelcontext}

The context of the model generator. Usage: [Generate TypeScript models](/guide/generator-api#generate-typescript-models).

| Field | Required | Default | Effect |
| --- | --- | --- | --- |
| `root` | Yes | — | Existing TypeScript project directory. |
| `profile` | Yes | — | `GolemProfile`. |
| `directory` | No | `root` | The directory of the `golem.yaml`. Its `.golem/` receives the codec keys. |
| `exact` | No | `true` | Default for the `exact` option of a model that sets none. `golem.yaml` passes its root `exact`. |
| `output` | No | `<root>/src/generated/models` | Directory for files shared by all models of the job, and for the generated files of shared model files. |
| `sources` | No | files that end in `suffixes` below `<root>/src` | Model files. |
| `suffixes` | No | `['.model.ts', '.models.ts']` | File-name endings that make a file below `<root>/src` a model source. |
| `manifestInputs` | No | `[]` | SDK `model-manifest.json` files whose types your declarations use. |
| `sdkOutputs` | No | `[]` | The absolute output folders of the SDK jobs of mode `golem` in the same `golem.yaml`. The model job writes the checks and conversions of each SDK. |
| `onInput` | No | omitted | Called with each path before it is read or checked. |
| `session` | No | omitted | Keeps the compiler running across calls. |

| Helper | Signature | Returns |
| --- | --- | --- |
| `discoverModelSources` | `(root?, onInput?, suffixes?): string[]` | Model files below `<root>/src`, sorted. |
| `generatedFilename` | `(source: string): string` | The generated file path: `task.model.ts` → `task.model.generated.ts`, `.models.ts` → `.models.generated.ts`. |
| `isModelSource` | `(filename: string): boolean` | Whether the name ends in `.ts`, `.mts` or `.cts`, a declaration file such as `customer.model.d.ts` included, and is not a generated file. |
| `discoverModelManifests` | `(root?, onInput?): string[]` | [`@exprtlabs/golem/manifest`](#manifest) re-export. |

Example:

```ts
import { apiVersion, generate } from '@exprtlabs/golem-model/generator';

const result = generate({
  root: '/absolute/app',
  profile: { mobx: false, validation: true },
});

console.log(apiVersion, result.artifacts.length);
```

## Apply results

A result is an in-memory plan. A build tool that applies it:

- keeps the artifact paths and contents,
- tracks `manifestPaths` and `watchInputs`,
- chooses its own write policy, stale-file policy and record of written files.

The `golem` CLI applies results in the [job order](/reference/config#job-order) of the configuration. Usage: [Apply the results](/guide/generator-api#apply-the-results).

## Generated code {#generated-code}

Generated files and rewritten sources import runtime helpers from internal entries of `@exprtlabs/golem`. These entries change with the golem version and are not application API. The CLI requires each built-in generator package to have the exact version of `@exprtlabs/golem` ([Runtime version](/reference/generated-files#runtime-version)).
