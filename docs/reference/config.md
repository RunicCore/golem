# Configuration

Put `golem.yaml` in the project that owns the source files. Paths
inside the file resolve from its directory; the `--config` value resolves
from the current directory.

- `version: 1` selects the configuration format and is independent of the package release.
- `tsconfig` names the TypeScript project that `golem generate` reads and `golem build` builds. The Vite and esbuild plugins and the Node loader open the same project from `golem.yaml`: the `config` option of the plugin, else `GOLEM_CONFIG`, else `./golem.yaml`.
- `mobx`, `validation` and `allowAny` apply to every job. `exact` applies to the models job and to the models that controller jobs describe. A named `IObject` or `IModel` can still set `validation`, `allowAny` and `exact` for that declaration.
- Unknown keys are errors.
- Configure at least one `generators`, `controllers`, `openapi` or `models` job.

The CLI runs [generator jobs](#generator-jobs) first, controller jobs next, OpenAPI SDK jobs third and model jobs
last. A model job can therefore consume the manifest emitted by an SDK job.
Golem replaces only files that it generated ([files Golem owns](/guide/watch#files-golem-owns)).

## Root keys

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `version` | literal `1` | Yes | — | Configuration format version. |
| `tsconfig` | path | No | `tsconfig.json` | The project's tsconfig, relative to `golem.yaml`. The file must exist when you set the key. One tsconfig belongs to one `golem.yaml`: the `root` of a `models` or `controllers` job must lie inside its directory, and each job must find that same file as the nearest `tsconfig.json` from its `root` upward. The `models` job `output` must also lie inside that directory, or loading `golem.yaml` fails. An SDK, a document or generator output may lie anywhere. A `tsconfig` that names another file is not supported yet. |
| `mobx` | boolean | No | `false` | Generate MobX observability hooks. |
| `validation` | boolean | No | `true` | Generate runtime validation metadata and checks. Named `IObject` / `IModel` `{ validation: true or false }` overrides this per declaration. |
| `allowAny` | boolean | No | `false` | Permit fields typed `any` or `unknown` in models. Without it, such a field fails with [`RUNM1011`](/reference/diagnostics#runm1011). An `IObject` or `IModel` can opt in with `IObject<F, { allowAny: true }>`, or tighten this policy explicitly. |
| `exact` | boolean | No | `true` | Reject extra properties in models. `false` admits keys that a model does not list. An `IObject` or `IModel` can override it with `IObject<F, { exact: false }>`. |
| `unknownFormats` | `warn` or `error` | No | `error` | What generation does with a schema `format` that golem does not check. `error` stops generation with [`VALIDATE_UNKNOWN_FORMAT`](/reference/diagnostics#validate-unknown-format); `warn` reports it and does not check that format. |
| `nonModelInputs` | `warn` or `error` | No | `error` | What `golem build`, `golem check`, the Vite plugin, the esbuild plugin and the Node loader do with a `@Body()` or `@Query()` parameter, whole or one field, whose type is no `IModel` or `IObject`. `error` stops with [`RUNM1081`](/reference/diagnostics#runm1081); `warn` continues; `golem build` and `golem check` print the warning, and the plugins and the loader print nothing. Set `warn` when your own interceptor handles those parameters. |
| `generators` | array of generator jobs | No | — | A non-empty list of [jobs from installed packages](#generator-jobs). |
| `controllers` | array of controller jobs | No | — | A non-empty list of controller-to-OpenAPI jobs. |
| `openapi` | array of OpenAPI jobs | No | — | A non-empty list of OpenAPI SDK jobs. |
| `models` | object | No | — | One TypeScript model job. |

```yaml
version: 1
mobx: false
validation: true
allowAny: false
exact: true
unknownFormats: error
nonModelInputs: error
openapi:
  - input: api.yaml
    output: sdk
    name: Tasks
models:
  root: .
  output: src/generated/models
```

An OpenAPI input may be absent on the first run when a controller job produces
that exact file. Keep each generated output in its own destination; overlapping
outputs are rejected.

## Validation profiles

| Profile | Runtime behavior | Application setup |
| --- | --- | --- |
| `validation: true` (default) | Generated checks run in TypeScript validator modules written beside the models and SDK, including nested models and custom bindings. | None. Compile the generated files with the rest of the project. |
| `validation: false` | Conversion runs without generated checks unless a named I* sets `{ validation: true }`. | Calling serde with `{ validate: true }` on a stub throws `LibErrorKind.ValidationUnavailable`. |

Custom predicates and serde bindings must be exported functions that the generator can import. An unresolved binding or imported schema stops generation with a diagnostic.

A `format` is checked only when golem implements it: `date-time`, `date`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uuid`, `regex`, `byte`, `json-pointer`, `relative-json-pointer`, `int32`, `int64`, `float` and `double`. The OpenAPI formats `password` and `binary` are known and check nothing. Any other format stops generation. Set `unknownFormats: warn` to report it as a warning and skip its check.

Disabling validation does not disable conversion guards, codecs, JSON
representability checks or generation diagnostics.

## Controller jobs

Install `@exprtlabs/golem-ts-openapi` to use `controllers`. A job reads static
NestJS controller contracts; it does not start Nest or reproduce module
registration. Use `sources` when discovery should include only selected
controllers.

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `framework` | literal `'nestjs'` | No | `nestjs` (NestJS 11) | Controller framework the job reads contracts from. |
| `root` | path | No | `.` | TypeScript project directory. |
| `sources` | array of paths | No | — | Explicit config-relative controller files. When omitted, scans `src/**` below `root` for the `suffixes`. |
| `suffixes` | array of strings | No | `[".controller.ts"]` | File-name endings that make a file below `root/src` a controller source. Each entry starts with `.`, ends in `.ts`, `.mts` or `.cts`, appears once, and does not end in `.generated.<ext>`. |
| `output` | path | Yes | — | One config-relative `.json`, `.yaml` or `.yml` document. |
| `openapiVersion` | `'3.2.0'` or `'3.1.2'` | No | `3.2.0` | Document dialect. Use `3.1.2` for consumers that require that target; contracts that cannot be represented fail generation. |
| `info` | object | Yes | — | OpenAPI information object, including the API `title` and `version`. |
| `servers` | array of objects | No | — | OpenAPI server objects, including each server's `url`. |
| `tags` | array of objects | No | — | OpenAPI tag objects with a `name` and optional description. |
| `securitySchemes` | object | No | — | Named OpenAPI security schemes referenced by controller metadata. |
| `globalPrefix` | string | No | — | Prefix added to every route, matching the Nest application configuration. |
| `uriVersioning` | object | No | — | URI versioning settings: optional `type` (`URI`, `uri` or `0`), `prefix` (default `v`) and `defaultVersion` as a string or string array. Required when controllers declare versions. |

```yaml
version: 1
tsconfig: backend/tsconfig.json
controllers:
  - framework: nestjs
    root: backend
    output: api/payments.yaml
    info:
      title: Payments API
      version: '1'
    globalPrefix: api
    uriVersioning:
      prefix: v
      defaultVersion: '1'
openapi:
  - input: api/payments.yaml
    output: sdk
    name: Payments
```

- The `backend` folder in this example has its own `tsconfig.json`, so `tsconfig` names it. Without one, leave `tsconfig` out to use the one beside `golem.yaml`.
- A controller job writes only its configured document file.
- Route helper return values over 1 MiB are rejected ([route helpers](/guide/nestjs-requests#route-helpers)).

### Query compatibility

| Target | Whole-query contract |
| --- | --- |
| OpenAPI 3.2 | Emits `in: querystring` with form content and the complete query schema. |
| OpenAPI 3.1.2 | Flattens independent fields into named parameters and rejects contracts whose constraints would be lost. |

Named `@Query('name')` parameters remain ordinary query parameters. Whole-query
form encoding supports flat scalars and scalar arrays; arbitrary nested
objects, dictionaries and nullable form values are rejected.

## OpenAPI jobs

::: info Reference resolution
The generator assembles local and allowed remote `$ref`s into one document. Schemas from other files become components named after their path, such as `schemas/user.json` → `schemas.user` (model `SchemasUser`). A root component that is only a `$ref` to an external file, such as `components.schemas.Money: { $ref: './money.json' }`, keeps its own name; a root component with a `$ref` plus other keys is not an alias, so its target still gets the path-based name. Two sources that produce the same name fail generation, naming both locations.
:::

Install `@exprtlabs/golem-openapi` to use `openapi`. Each job reads one YAML or
JSON document and writes one SDK directory.

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `input` | path | Yes | — | Config-relative OpenAPI YAML or JSON file. An earlier job of the file may write it. |
| `output` | path | Yes | — | Config-relative SDK output directory. |
| `name` | string | No | — | Prefix used for generated client and operation types. |
| `allowRemoteRefs` | boolean | No | `false` | Permit HTTPS `$ref` documents. |
| `remoteHosts` | array of strings | No | `[]` | Hostname allowlist required when remote references are enabled. |
| `maxRefBytes` | positive integer | No | `5242880` | Maximum bytes read from one referenced document, local or remote. |
| `maxRefDocuments` | positive integer | No | `256` | Maximum referenced documents discovered, including local references. |
| `refTimeoutMs` | positive integer | No | `10000` | Remote reference read timeout in milliseconds. |
| `dates` | `date` or `temporal` | No | `date` | `temporal` maps `format: date-time` to `Temporal.Instant`, `date` to `Temporal.PlainDate` and `duration` to `Temporal.Duration`, converted by [`@exprtlabs/golem/temporal`](/reference/runtime-api#temporal). `time` stays a string. Encoding a `Temporal.Instant` writes `Z`, so the original offset is not kept. |

Local references stay within the input document's directory. Validation and
reference limits apply even when `validation: false`; that flag controls
generated runtime schema checks.

Keep generated files under the configured output, so the CLI can delete files
it generated earlier that are no longer produced.

## TypeScript models {#typescript-models}

Install `@exprtlabs/golem-model` to use `models`.

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `root` | path | No | `.` | TypeScript project directory. |
| `sources` | array of paths | No | — | Explicit config-relative model files, which may have any `.ts`, `.mts` or `.cts` name. Each one must export an `IModel` or `IObject` alias, or generation stops. Each one must be inside `root`, or generation stops with [RUNM1075](/reference/diagnostics#runm1075). When omitted, every file below `<root>/src` and every file that the tsconfig includes or imports is a model source when it ends in one of the `suffixes`. A model source outside `root` is a [shared model file](#a-folder-shared-by-several-apps). The job skips a discovered file that has no `IModel` or `IObject` alias. |
| `suffixes` | array of strings | No | `[".model.ts", ".models.ts"]` | File-name endings that make a file a model source. Each entry starts with `.`, ends in `.ts`, `.mts` or `.cts`, appears once, and does not end in `.generated.<ext>`. |
| `output` | path | No | `<root>/src/generated/models` | The folder of the validators file, `models.validators.generated.ts`, and of the generated files of shared model files. It must not overlap another job. The tsconfig must include it. |

The generated file for each model source stays beside it and puts `.generated`
before the final extension: `order.entity.ts` gets `order.entity.generated.ts`.
Explicit `sources` must be non-empty and must not contain duplicates. A source file may be one that an earlier job writes.

```yaml
version: 1
allowAny: false
models:
  root: .
  sources:
    - src/task.model.ts
    - src/payment-editor.model.ts
  output: src/generated/models
```

### A folder shared by several apps

A shared folder or package declares models. Several apps can include one folder of types, link it, or install it from `node_modules`. The folder needs no `golem.yaml`, and the app needs no configuration for it.

Each app includes the folder in its own tsconfig, with a `rootDir` that contains both:

```json
{
  "compilerOptions": { "rootDir": "..", "outDir": "build" },
  "include": ["src/**/*.ts", "../shared/**/*.ts"]
}
```

The shared folder declares the `IModel` or `IObject` aliases in a model file, a file whose name ends in one of the `models.suffixes`. A shared folder or package holds declarations and the functions its tags use, such as a `TSerde` function: no class and no generated file.

<<< ../../examples/shared-folder/shared/customer.model.ts#shared-model

A model file whose real path is inside `models.root` is a model file of the app, and its generated file stays beside it. Golem follows folder links to find the real path. Every other model file is a shared model file, whether the app reaches it by a plain include, a folder link, a linked workspace package or `node_modules`. Its aliases are models of the app. A declaration file such as `customer.model.d.ts` is always a shared model file, also inside `models.root`, because it cannot hold your class. The models of an SDK are the exception: a model file that a `model-manifest.json` lists keeps the generated code of the SDK.

Each app generates the shared models in its own `models.output`, so several apps never write to one file, and golem writes nothing into the shared folder. The generated file is at:

```text
<models.output>/<package name>/<path of the file in the package>.generated.ts
```

The package is the nearest folder above the file whose `package.json` has a `name`, and the package name is that `name`. When no such folder exists, the package is the top folder below the folder that holds both the file and your `golem.yaml`, and the package name is the folder name. With a `package.json` named `@acme/shared`, the file `shared/customer.model.ts` gives `src/generated/models/@acme/shared/customer.model.generated.ts` in `apps/web`. For a declaration file, the generated name drops `.d`.

A package name that is absolute or has a `..` segment stops generation, because the name is a folder of `models.output`. Two shared model files that get one path stop generation with [RUNM1078](/reference/diagnostics#runm1078).

Your code imports the generated base class from the file in its own `models.output`, and the class that extends it stays in the app. Each app can add its own methods:

<<< ../../examples/shared-folder/apps/web/src/customer.ts#web-class

Each app has its own profile. The worker below uses the same shared model with `validation: false`, and loads the generated file of its own `models.output`:

<<< ../../examples/shared-folder/apps/worker/src/customers.ts#worker-use

A shared folder can also hold:

- Plain types. A plain type is a field type of a model. Its constraints, such as `MinLength`, apply in the generated file of that model.
- `TSerde` and `TValidation` functions. Golem imports a function of the folder by a relative path, also when a named package above the app, such as a monorepo root, holds the folder.

A `package.json` in the folder with a `name` makes the folder a package. Golem then imports its functions by that name. Each app must resolve the name, and an `exports` entry must reach the file of the function. Without it, generation fails with [RUNM1060](/reference/diagnostics#runm1060). A file in `node_modules` always imports by the package name. A `package.json` without a `name` has no effect on these imports.

A shared folder holds no `golem.yaml` and no generated file. When one is there, golem writes the warning [RUNM1076](/reference/diagnostics#runm1076), ignores the file and continues:

- A `golem.yaml` in the folder of a shared model file, or in a folder between the file and its package folder. Golem does not read it.
- A generated file beside a shared model file, such as `customer.model.generated.ts`, `.generated.js` or `.generated.d.ts`. Golem does not use it. The app uses its own generated file.

`golem generate`, `golem check`, `golem build` and watch write each warning once for each run.

A `golem.yaml` with a `models` job below the `models.root` of another `golem.yaml` stops `golem generate` and `golem check` with [RUNM1077](/reference/diagnostics#runm1077). Both jobs would write the same generated files. Remove the `models` job from the nested `golem.yaml`, or move its folder out of the root.

An `IModel` or `IObject` alias in a file that does not end in a model suffix is not a model. A field type or a serde call that uses it stops with [RUNM1074](/reference/diagnostics#runm1074). Move the alias into a model file.

Full example: [`examples/shared-folder`](https://github.com/RunicCore/golem/tree/master/examples/shared-folder), with a shared folder that declares a model, one app that includes the folder and one that reaches it through a folder link.

The global `allowAny` and `exact` settings default to `false` and `true`. A
model that has an `any` or `unknown` field needs `allowAny: true`. An `IObject`
or `IModel` can opt in with `IObject<Fields, { allowAny: true }>` or tighten a
global `true` with `IObject<Fields, { allowAny: false }>`. The same holds for
`exact`: `IObject<Fields, { exact: false }>` admits extra keys in one model,
and `exact: false` in `golem.yaml` admits them in every model. The
declaration's own setting wins when present; then the `golem.yaml` value
applies, then the default. `allowAny` does not suppress explicit tags or bypass
JSON representability. Referenced models keep their own policy.

## Generator jobs

Install a package that provides a generator and list it under `generators`. Its jobs run before the built-in jobs, so the models job processes the files it writes.

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `package` | string | Yes | Installed third-party package that exports `./generator`; its version is independent of golem's. Name the built-in packages through `models`, `openapi` or `controllers` instead. |
| `output` | path | Yes | Config-relative directory the generator owns. |
| `options` | object | No | Passed to the generator as-is; the generator validates it. |
