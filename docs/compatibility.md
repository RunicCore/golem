# Compatibility

Check which versions Golem supports and which APIs stay stable.

## Supported versions

| Requirement | Version |
| --- | --- |
| Node.js | `>=22.15.0` |
| TypeScript | `>=6.0.0 <7` or `>=7.0.0 <8` |
| NestJS | `^11.0.0` (`@nestjs/common`) |
| OpenAPI input documents | 3.1, 3.2 |
| OpenAPI output (`openapiVersion`) | `3.2.0` (default) or `3.1.2` |

Generation, `golem build` and the `parse<T>` rewrite write the same files on TypeScript 6 and on TypeScript 7. `golem build`, the Vite plugin, the esbuild plugin and the Node loader are all supported.

OpenAPI feature support depends on the document version and generation profile ([OpenAPI support](/reference/openapi-support)).

## Windows

Windows support is best effort. Golem makes no promise for Windows. When you report a problem on Windows, we fix it.

## Stability and public API {#public-api}

The configuration format (`version: 1`) and the public subpaths of `@exprtlabs/golem` follow semver from 1.0.0. The [runtime API](/reference/runtime-api) page lists the public subpaths.

A path that starts with `internal/` may change in any release. Do not import it.

## TypeScript resolution {#ts}

Golem uses the `typescript` package that resolves from the directory of the tsconfig that your `golem.yaml` names. The `golem` command and every host look there, wherever the process runs from. The hosts are the [Vite](/reference/runtime-api#vite) and [esbuild](/reference/runtime-api#esbuild) plugins and the [Node loader](/reference/runtime-api#loader). Every lookup falls back to the copy beside Golem.

Set `GOLEM_TYPESCRIPT_ROOT` to a directory to use the `typescript` installed there instead. It overrides every project. Library use outside a host looks in `GOLEM_TYPESCRIPT_ROOT`, or in the current directory when the variable is not set.

A process loads one TypeScript. A host fails when it opens a second project whose `typescript` is a different install. The message tells you to run one host for each TypeScript install. Projects that share one install, through a link or a hoisted `node_modules`, can open in one process.

A `typescript` version outside the range in the table fails at load:

```text
golem supports TypeScript 6.0+ and 7.x; found <version> at <path>.
```

With TypeScript 7, the project and Golem must resolve one install. When they differ, loading fails:

```text
golem loads TypeScript 7 (<version>) from <path> but the project uses <version> at <path>; install one TypeScript 7 for both.
```

When neither the project nor Golem has `typescript`, a command that needs the compiler fails with `golem needs TypeScript 6.0+ or 7.x installed in <directory>.`

## Defaults

- Validation and `exact` are enabled by default. MobX and `allowAny` are disabled by default ([configuration](/reference/config#root-keys)).
- `exact` applies to the models job and to the models that controller jobs describe. The other feature flags apply to every job. An individual `IObject` or `IModel` can override `exact`, `allowAny` and `validation`.
- Callback and webhook types are generated. Your application implements their handlers.
- Response links are emitted as metadata. Clients do not follow them automatically.
