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
| `allowAny` | boolean | No | `false` | Permit fields typed `any` or `unknown` in models. A declaration can override it ([`any` and `unknown`](/guide/field-types#any-and-unknown)). |
| `exact` | boolean | No | `true` | Reject extra properties in models. `false` admits keys that a model does not list. A declaration can override it ([Objects and exact](/guide/field-types#objects-and-exact)). |
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
- How controller constructs become OpenAPI, including route helpers and query objects, is in [NestJS controllers](/reference/nestjs).

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
| `sources` | array of paths | No | — | Explicit config-relative model files, which may have any `.ts`, `.mts` or `.cts` name. Each one must export an `IModel` or `IObject` alias, or generation stops. Each one must be inside `root`, or generation stops with [RUNM1075](/reference/diagnostics#runm1075). When omitted, every file below `<root>/src` and every file that the tsconfig includes or imports is a model source when it ends in one of the `suffixes`. A model source outside `root` is a [shared model file](/guide/shared-models#where-each-app-writes). The job skips a discovered file that has no `IModel` or `IObject` alias. |
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

Models from a [shared folder or package](/guide/shared-models) are generated in the `models.output` of each app.

## Generator jobs

Install a package that provides a generator and list it under `generators`. Its jobs run before the built-in jobs, so the models job processes the files it writes.

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `package` | string | Yes | Installed third-party package that exports `./generator`; its version is independent of golem's. Name the built-in packages through `models`, `openapi` or `controllers` instead. |
| `output` | path | Yes | Config-relative directory the generator owns. |
| `options` | object | No | Passed to the generator as-is; the generator validates it. |
