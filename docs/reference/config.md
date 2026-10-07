| `sources` | array of paths | No | — | Explicit config-relative model files, which may have any `.ts`, `.mts` or `.cts` name. Each one must have an exported `IModel` or `IObject` alias. When omitted, every file below `<root>/src` and every file that the tsconfig includes or imports is a model source when it ends in one of the `suffixes`, also outside `root` ([shared folder](#a-folder-shared-by-several-apps)). The job skips such a file when it has no `IModel` or `IObject` alias, or when the `golem.yaml` of its folder has a `models` job of its own. |
# Configuration

Put `golem.yaml` in the project that owns the source files. Paths
inside the file resolve from its directory; the `--config` value resolves
from the current directory.

- `version: 1` selects the configuration format and is independent of the package release.
- `tsconfig` names the TypeScript project that `golem generate` reads and `golem build` builds. The Vite and esbuild plugins and the Node loader open the same project from `golem.yaml`: the `config` option of the plugin, else `GOLEM_CONFIG`, else `./golem.yaml`.
- `mobx`, `validation` and `allowAny` apply to every job. A named `IObject` or `IModel` can still set `validation` and `allowAny` for that declaration.
- Unknown keys are errors.
- Configure at least one `generators`, `controllers`, `openapi` or `models` job.

The CLI runs [generator jobs](#generator-jobs) first, controller jobs next, OpenAPI SDK jobs third and model jobs
last. A model job can therefore consume the manifest emitted by an SDK job.
It records what it writes in an [inventory](/guide/watch#generated-files-and-the-inventory).

## Root keys

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `version` | literal `1` | Yes | — | Configuration format version. |
| `tsconfig` | path | No | `tsconfig.json` | The project's tsconfig, relative to `golem.yaml`. The file must exist when you set the key. One tsconfig belongs to one `golem.yaml`: the `root` of a `models` or `controllers` job must lie inside its directory, and each job must find that same file as the nearest `tsconfig.json` from its `root` upward. A `tsconfig` that names another file is not supported yet. |
| `mobx` | boolean | No | `false` | Generate MobX observability hooks. |
| `validation` | boolean | No | `true` | Generate runtime validation metadata and checks. Named `IObject` / `IModel` `{ validation: true or false }` overrides this per declaration. |
| `allowAny` | boolean | No | `false` | Permit inferred `any` fields in models. An `IObject` or `IModel` can opt in with `IObject<F, { allowAny: true }>`, or tighten this policy explicitly. |
| `unknownFormats` | `warn` or `error` | No | `warn` | What generation does with a schema `format` that golem does not check. `warn` reports [`VALIDATE_UNKNOWN_FORMAT`](/reference/diagnostics#validate-unknown-format) and does not check that format; `error` stops generation. |
| `generators` | array of generator jobs | No | — | A non-empty list of [jobs from installed packages](#generator-jobs). |
| `controllers` | array of controller jobs | No | — | A non-empty list of controller-to-OpenAPI jobs. |
| `openapi` | array of OpenAPI jobs | No | — | A non-empty list of OpenAPI SDK jobs. |
| `models` | object | No | — | One TypeScript model job. |

```yaml
version: 1
mobx: false
validation: true
allowAny: false
unknownFormats: warn
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

A `format` is checked only when golem implements it: `date-time`, `date`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uuid`, `regex`, `byte`, `json-pointer`, `relative-json-pointer`, `int32`, `int64`, `float` and `double`. The OpenAPI formats `password` and `binary` are known and check nothing. Set `unknownFormats: error` to fail generation on any other format instead of skipping its check.

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
- Route helper return values over 1 MiB are rejected ([route helpers](/guide/nestjs-in-depth#route-helpers)).

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
| `input` | path | Yes | — | Config-relative OpenAPI YAML or JSON file. |
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
| `sources` | array of paths | No | — | Explicit config-relative model files, which may have any `.ts`, `.mts` or `.cts` name. When omitted, every file below `<root>/src` and every file that the tsconfig includes or imports is a model source when it ends in one of the `suffixes`, also outside `root` ([shared folder](#a-folder-shared-by-several-apps)). |
| `suffixes` | array of strings | No | `[".model.ts", ".models.ts"]` | File-name endings that make a file a model source. Each entry starts with `.`, ends in `.ts`, `.mts` or `.cts`, appears once, and does not end in `.generated.<ext>`. |
| `output` | path | No | `<root>/src/generated/models` | The layer of the app and its validators. It must not overlap another job. The tsconfig must include it. When the layer is outside the `include` of the tsconfig, `golem build` stops with an error that names the layer and the tsconfig. |

The generated file for each model source stays beside it and puts `.generated`
before the final extension: `order.entity.ts` gets `order.entity.generated.ts`.
Explicit `sources` must be non-empty and must not contain duplicates.

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

Several apps can include one folder of models. The folder needs no `golem.yaml`, and the app needs no configuration for it.

Each app includes the folder in its own tsconfig, with a `rootDir` that contains both:

```json
{
  "compilerOptions": { "rootDir": "..", "outDir": "build" },
  "include": ["src/**/*.ts", "../shared/**/*.ts"]
}
```

A models job generates every model file that its tsconfig includes or imports, also outside `<root>/src`. So `golem generate` and `golem build` in the app generate the models of the folder, and a model of the app can use one as a field type. A model file of the folder imports only files of the folder and installed packages. When it imports another file, generation stops with an error that names the import.

A discovered file is skipped, without a message, in two cases. A file that has no `IModel` or `IObject` alias is not a model file, so the job writes no generated file for it and does not touch a file beside it. A file that the `models` job of another `golem.yaml` covers is left to that job: the `golem.yaml` is in the folder of the file, or in a folder above it up to the shared folder. A file that `sources` names is never skipped, and it must have an alias.

The generated files beside the models of the folder are the same text in every app. Each app has its own layer, `models.generated.ts` in `models.output`. The layer holds the `mobx` and `validation` settings of the app and the schemas, validators and serde bindings of its models. A generated file of the folder imports the layer through the specifier `#golem-models`. So each app runs the shared models with its own profile.

Golem resolves `#golem-models` for `golem build`, the Node loader, the Vite plugin, the esbuild plugin and TypeScript. The tsconfig needs no `paths` entry.

A tool outside golem needs help in two cases. `golem build` needs neither.

In the first case, Node runs JavaScript that plain `tsc` emitted. Node reads an `imports` entry from the nearest `package.json` of the importing file. Point the entry at the layer that `tsc` emitted into the `outDir`, not at the TypeScript file. The path starts at the `package.json` of the app. It has the `outDir`, then the path of the layer from the `rootDir`, then `models.generated.js`. With the `rootDir` and `outDir` above, an app in the folder `app` and the default `models.output`, the entry is:

```json
{
  "imports": { "#golem-models": "./build/app/src/generated/models/models.generated.js" }
}
```

In the second case, a tool runs the TypeScript sources of the shared folder, such as Jest, Vitest or tsx. It needs its own alias, or a `paths` entry in its tsconfig, that maps `#golem-models` to the layer of the app.

Give the shared folder a `package.json` with a `name`. Golem then names each `TSerde` and `TValidation` function of the folder by that package, so its id is the same in every app. The `name` is enough when the models and their functions are in the shared folder. When a model outside the folder uses a function of the folder, the `package.json` of the folder also needs an `exports` entry that reaches the file of the function. Without it, generation fails with [RUNM1060](/reference/diagnostics#runm1060). Two shared folders without a name that have a function with the same file name and export name fail with a collision error.

One process at a time writes the generated files of a shared folder. It keeps the lock in `.golem.lock` in the folder. Put `.golem.lock` in `.gitignore`. The lock rules are in the [watch guide](/guide/watch#shared-model-folders).

A shared folder can have a `golem.yaml` with a `models` job of its own. Then that job generates the files of the folder, and an app that includes the folder generates none of them.

An app that stops including the folder leaves the generated files in it, because another app can use them. Golem deletes the generated file of a model file that no longer exists.

The global `allowAny` policy defaults to `false`. An `IObject` or `IModel` can
opt in with `IObject<Fields, { allowAny: true }>` or tighten a global `true`
profile with `IObject<Fields, { allowAny: false }>`. The declaration's own
setting wins when present; otherwise the global profile applies. `allowAny`
does not change `unknown`, suppress explicit tags or bypass JSON
representability. Referenced models keep their own policy.

## Generator jobs

Install a package that provides a generator and list it under `generators`. Its jobs run before the built-in jobs, so the models job processes the files it writes.

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `package` | string | Yes | Installed third-party package that exports `./generator`; its version is independent of golem's. Name the built-in packages through `models`, `openapi` or `controllers` instead. |
| `output` | path | Yes | Config-relative directory the generator owns. |
| `options` | object | No | Passed to the generator as-is; the generator validates it. |
