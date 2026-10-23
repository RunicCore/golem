# Configuration

Put `golem.yaml` in the project that owns the source files. Paths in the file are relative to its directory. The `--config` value is relative to the current directory.

- `version: 1` selects the configuration format. It is independent of the package release.
- `tsconfig` names the TypeScript project that `golem generate` reads and `golem build` builds. The Vite and esbuild plugins and the Node loader open the same project from `golem.yaml`. They read the `config` option of the plugin, then `GOLEM_CONFIG`, then `./golem.yaml`.
- `mobx`, `validation` and `allowAny` apply to every job. `exact` applies to the models job and to the models that controller jobs describe. A named `IObject` or `IModel` can still set `validation`, `allowAny` and `exact` for that declaration.
- Unknown keys are errors.
- Configure at least one `generators`, `controllers`, `openapi` or `models` job.

The CLI runs [generator jobs](#generator-jobs) first, then controller jobs, then OpenAPI SDK jobs, and model jobs last. A model job can therefore read the manifest that an SDK job writes. A job that reads the output of a later job is a cycle error.

## Root keys

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `version` | literal `1` | Yes | — | Configuration format version. |
| `tsconfig` | path | No | `tsconfig.json` | The project's tsconfig, relative to `golem.yaml`. The file must exist when you set the key. One `golem.yaml` serves one tsconfig ([what the tsconfig needs](/reference/cli#what-the-tsconfig-needs)). |
| `mobx` | boolean | No | `false` | Generate MobX observability hooks. |
| `validation` | boolean | No | `true` | Generate runtime validation metadata and checks. A named `IObject` or `IModel` with `{ validation: true or false }` overrides this for its declaration. |
| `allowAny` | boolean | No | `false` | Permit fields typed `any` or `unknown` in models. A declaration can override it ([`any` and `unknown`](/guide/field-types#any-and-unknown)). |
| `exact` | boolean | No | `true` | Reject extra properties in models. `false` admits keys that a model does not list. A declaration can override it ([Objects and exact](/guide/field-types#objects-and-exact)). |
| `unknownFormats` | `warn` or `error` | No | `error` | What generation does with a schema `format` that golem does not check. `error` stops generation with [`VALIDATE_UNKNOWN_FORMAT`](/reference/diagnostics#validate-unknown-format). `warn` reports it and skips the check of that format. |
| `nonModelInputs` | `warn` or `error` | No | `error` | What `golem build`, `golem check`, the Vite plugin, the esbuild plugin and the Node loader do with a `@Body()` or `@Query()` parameter whose type is no `IModel` or `IObject`. The parameter can be whole or one field. `error` stops with [`RUNM1081`](/reference/diagnostics#runm1081). `warn` continues. `golem build` and `golem check` print the warning. The plugins and the loader print nothing. Set `warn` when your own interceptor handles those parameters. |
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

## Output paths

Each job writes only below its `output`. Golem replaces only files that it generated ([files Golem owns](/guide/watch#files-golem-owns)).

- An `output` is relative to `golem.yaml`. For example, `output: ../shared-sdk` writes an SDK to a sibling folder.
- Outputs of different jobs must not overlap. An output inside another output stops loading `golem.yaml`.
- Two artifacts for one file, or an artifact for `golem.yaml` itself, stop generation with `Generated output collision`.
- A destination that leaves its `output` through a symbolic link stops generation before any write.
- An OpenAPI `input` may be absent on the first run when an earlier controller job writes that exact file.

## Validation profiles

| Profile | Runtime behavior | Application setup |
| --- | --- | --- |
| `validation: true` (default) | Generated checks run in TypeScript validator modules beside the models and the SDK. They cover nested models and custom bindings. | None. Compile the generated files with the rest of the project. |
| `validation: false` | Conversion runs without generated checks. A named `IObject` or `IModel` with `{ validation: true }` still gets them. | Calling serde with `{ validate: true }` on a stub throws `LibErrorKind.ValidationUnavailable`. |

Custom predicates and serde bindings must be exported functions that the generator can import. An unresolved binding or imported schema stops generation with a diagnostic.

A `format` is checked only when golem implements it. These formats are checked: `date-time`, `date`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uuid`, `regex`, `byte`, `json-pointer`, `relative-json-pointer`, `int32`, `int64`, `float` and `double`. The formats `password`, `binary` and `media-range` are known and check nothing. Any other format stops generation. Set `unknownFormats: warn` to report it as a warning and skip its check.

Disabling validation does not disable conversion guards, codecs, JSON representability checks or generation diagnostics.

## Controller jobs

Install `@exprtlabs/golem-ts-openapi` to use `controllers`. A job reads static NestJS controller contracts. It does not start Nest and does not reproduce module registration. Use `sources` to read only selected controllers.

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `framework` | literal `'nestjs'` | No | `nestjs` (NestJS 11) | Controller framework that the job reads. |
| `root` | path | No | `.` | TypeScript project directory. |
| `sources` | array of paths | No | — | Config-relative controller files. Without it, the job scans `src/**` below `root` for the `suffixes`. |
| `suffixes` | array of strings | No | `[".controller.ts"]` | File-name endings that make a file below `root/src` a controller source. Each entry starts with `.`, ends in `.ts`, `.mts` or `.cts`, appears once, and does not end in `.generated.<ext>`. |
| `output` | path | Yes | — | One config-relative `.json`, `.yaml` or `.yml` document. |
| `openapiVersion` | `'3.2.0'` or `'3.1.2'` | No | `3.2.0` | Document dialect. Use `3.1.2` for consumers that need it. A contract that `3.1.2` cannot represent stops generation. |
| `info` | object | Yes | — | OpenAPI information object with the API `title` and `version`. |
| `servers` | array of objects | No | — | OpenAPI server objects, each with a `url`. |
| `tags` | array of objects | No | — | OpenAPI tag objects with a `name` and an optional description. |
| `securitySchemes` | object | No | — | Named OpenAPI security schemes that controller metadata references. |
| `globalPrefix` | string | No | — | Prefix for every route. Match the Nest application configuration. |
| `uriVersioning` | object | No | — | URI versioning with an optional `type` (`URI`, `uri` or `0`), a `prefix` (default `v`) and a `defaultVersion` as a string or an array of strings. Set it when controllers declare versions. |

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

- The `backend` folder in this example has its own `tsconfig.json`, so `tsconfig` names it. Without one, leave `tsconfig` out to use the file beside `golem.yaml`.
- A controller job writes its configured document and `src/generated/operation-codecs.ts` below `root`.
- How controller constructs become OpenAPI, including route helpers and query objects, is in [NestJS controllers](/reference/nestjs). Query objects on each OpenAPI version are in [query compatibility](/reference/nestjs#query-compatibility).

## OpenAPI jobs

Install `@exprtlabs/golem-openapi` to use `openapi`. Each job reads one YAML or JSON document and writes one SDK directory.

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `input` | path | Yes | — | Config-relative OpenAPI YAML or JSON file. An earlier job of the file may write it. |
| `output` | path | Yes | — | Config-relative SDK output directory. |
| `name` | string | No | — | Prefix for generated client and operation types. |
| `allowRemoteRefs` | boolean | No | `false` | Permit HTTPS `$ref` documents. |
| `remoteHosts` | array of strings | No | `[]` | Hostname allowlist. Required when you permit remote references. |
| `maxRefBytes` | positive integer | No | `5242880` | Maximum bytes to read from one referenced document, local or remote. |
| `maxRefDocuments` | positive integer | No | `256` | Maximum referenced documents, local ones included. |
| `refTimeoutMs` | positive integer | No | `10000` | Timeout for a remote reference read, in milliseconds. |
| `dates` | `date` or `temporal` | No | `date` | `temporal` maps `format: date-time` to `Temporal.Instant`, `date` to `Temporal.PlainDate` and `duration` to `Temporal.Duration`. [`@exprtlabs/golem/temporal`](/reference/runtime-api#temporal) converts them. `time` stays a string. Encoding a `Temporal.Instant` writes `Z`, so the original offset is lost. |

The generator assembles local and allowed remote `$ref`s into one document. Local references stay within the directory of the input document. Schemas from other files become components named after their path, such as `schemas/user.json` → `schemas.user` (model `SchemasUser`). A root component that is only a `$ref` to an external file keeps its own name, such as `components.schemas.Money: { $ref: './money.json' }`. A root component with a `$ref` and other keys is not an alias, so its target gets the path-based name. Two sources with the same name stop generation, and the message names both locations.

## TypeScript models {#typescript-models}

Install `@exprtlabs/golem-model` to use `models`.

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `root` | path | No | `.` | TypeScript project directory. |
| `sources` | array of paths | No | — | Config-relative model files with any `.ts`, `.mts` or `.cts` name. Each file must export an `IModel` or `IObject` alias and must lie inside `root` ([RUNM1075](/reference/diagnostics#runm1075)). Without `sources`, every file below `<root>/src` and every file that the tsconfig includes or imports is a model source when it ends in one of the `suffixes`. A model source outside `root` is a [shared model file](/guide/shared-models#where-each-app-writes). The job skips a discovered file that has no `IModel` or `IObject` alias. |
| `suffixes` | array of strings | No | `[".model.ts", ".models.ts"]` | File-name endings that make a file a model source. Each entry starts with `.`, ends in `.ts`, `.mts` or `.cts`, appears once, and does not end in `.generated.<ext>`. |
| `output` | path | No | `<root>/src/generated/models` | The folder of `models.validators.generated.ts` and of the generated files of shared model files. It must lie inside the tsconfig directory and must not overlap another job. |

The generated file for each model source stays beside it and puts `.generated` before the final extension: `order.entity.ts` gets `order.entity.generated.ts`. Explicit `sources` must be non-empty and must not repeat a path. A source file may be one that an earlier job writes.

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

Models from a [shared folder or package](/guide/shared-models) are generated in the `models.output` of each app.

## Generator jobs

Install a package that provides a generator and list it under `generators`. Its jobs run before the built-in jobs, so the models job processes the files that it writes. [Write a generator](/guide/generators) shows the package.

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `package` | string | Yes | Installed third-party package that exports `./generator`. Its version is independent of golem's. Configure the built-in packages with `models`, `openapi` or `controllers`. |
| `output` | path | Yes | Config-relative directory that the generator owns. |
| `options` | object | No | Passed to the generator as written. The generator validates it. |
