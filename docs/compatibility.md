# Compatibility and stability

Check which versions Golem supports and which APIs stay stable.

## Supported versions

| Requirement | Version |
| --- | --- |
| Node.js | `>=22.15.0` |
| TypeScript | `>=6.0.0 <7` or `>=7.0.0 <8` |
| NestJS | `^11.0.0` (`@nestjs/common`) |
| OpenAPI input documents | 3.1, 3.2 |
| OpenAPI output (`openapiVersion`) | `3.2.0` (default) or `3.1.2` |

Generation, `golem build` and the `parse<T>` rewrite run on TypeScript 6.0 and later 6.x, or on 7.x, and write the same files on both. TypeScript 5 isn't supported. `golem build`, the Vite plugin, the esbuild plugin and the Node loader are all fully supported; faster transforms in a Vite dev server are an extra optimization that comes later.

CI runs the unit suite on Node.js 22.15.0 and 24, on Ubuntu and Windows; Windows jobs are allowed to fail.

OpenAPI feature support depends on the document version and generation profile ([OpenAPI client support](/reference/openapi-support)).

## Stability

The configuration format (`version: 1`) and the public subpaths of `@exprtlabs/golem` follow semver from 1.0.0. Until then, a release candidate may change them; each change is listed in [Release notes](/changelog).

## Public API

The [runtime API](/reference/runtime-api) page lists the public subpaths of `@exprtlabs/golem`. They follow semver from 1.0.0.

A path that starts with `internal/` may change in any release. Do not import it.

## TypeScript resolution {#ts}

Golem uses your project's installed `typescript`: the package that resolves from the directory of the tsconfig your `golem.yaml` names. The `golem` command and every host (the [Vite](/reference/runtime-api#vite) and [esbuild](/reference/runtime-api#esbuild) plugins and the [Node loader](/reference/runtime-api#loader)) look there, wherever the process runs from. Set `GOLEM_TYPESCRIPT_ROOT` to a directory to use the `typescript` installed there instead; it overrides every project. Library use outside a host looks in `GOLEM_TYPESCRIPT_ROOT`, or from the current directory when the variable is unset. Every lookup falls back to the copy beside Golem. A process loads one TypeScript: when a host opens a second project whose `typescript` is a different install from the one the process holds, it fails and says to run one host per TypeScript install. Projects that share one install, through a link or a hoisted `node_modules`, can open in one process. It selects the backend by version: `>=6.0.0 <7` or `>=7.0.0 <8`. Any other version fails at load:

```text
golem supports TypeScript 6.0+ and 7.x; found <version> at <path>.
```

Golem runs the TypeScript 6 backend on the install it resolved. The TypeScript 7 backend loads the TypeScript 7 beside Golem, so the project and Golem must resolve one install. When they differ, loading fails:

```text
golem loads TypeScript 7 (<version>) from <path> but the project uses <version> at <path>; install one TypeScript 7 for both.
```

When neither the project nor Golem has `typescript`, loading fails with `golem needs TypeScript 6.0+ or 7.x installed in <directory>.`

Both backends generate byte-identical files. A test lane enforces that.

## Feature defaults

- Validation and `exact` are enabled by default. MobX and `allowAny` are disabled by default.
- `exact` applies to the models job and to the models that controller jobs describe; the other feature flags apply to every job. An individual `IObject` or `IModel` can override `exact`, `allowAny` and `validation`.
- Callback and webhook types are generated; your application implements their handlers.
- Response links are emitted as metadata; clients don't follow them automatically.
