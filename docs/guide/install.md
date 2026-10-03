# Installation

Install the generator you need as a development dependency and the shared runtime as an application dependency.

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | `22.15` or newer |
| `typescript` | `>=6.0.0 <7` or `>=7.0.0 <8` |

Generation, `golem build` and the `parse<T>` rewrite run on TypeScript 6.0+ or 7.x and write the same files on both. Golem picks the version from the `typescript` installed in your project. TypeScript 5 isn't supported.

## Packages per generator

The `golem` command comes from `@exprtlabs/golem`, which every generator depends on. Install it in the project before you run `npx golem`: an unrelated npm package is also named `golem`, and without a local install `npx` offers to download and run that one, and in CI it runs it without asking. In scripts and CI, run `npx --no-install golem`, which fails instead.

| To generate | Development dependency |
| --- | --- |
| TypeScript models | `npm install --save-dev @exprtlabs/golem-model@rc` |
| An OpenAPI client | `npm install --save-dev @exprtlabs/golem-openapi@rc` |
| OpenAPI from NestJS controllers | `npm install --save-dev @exprtlabs/golem-ts-openapi@rc` |

Generated models and clients import the runtime:

```sh
npm install @exprtlabs/golem@rc
```

Generating OpenAPI from controllers doesn't need the runtime. A NestJS app that registers `NestModelInterceptor` does.

The generators declare the compiler as a peer dependency, so npm installs one copy in your project:

| Package | Peer dependencies |
| --- | --- |
| `@exprtlabs/golem-model` | `typescript` `>=6.0.0 <8` |
| `@exprtlabs/golem-ts-openapi` | `typescript` `>=6.0.0 <8` |
| `@exprtlabs/golem-openapi` | none; add `typescript` to compile the SDK |
| `@exprtlabs/golem` | optional: `typescript` (`>=6.0.0 <8`) for `golem build`; `vite` (`>=5`) and `esbuild` for their plugins; `ajv`, `ajv-formats`, `mobx`, `@nestjs/common`, `rxjs` for the features that use them |

## TypeScript setup

`parse<T>`, `stringify<T>`, `fromWireFormat<T>` and `toWireFormat<T>` are rewritten at build time to call the generated conversion. `tsc` doesn't do that, so an untransformed call throws at runtime. Build with one of these; each reads `.golem/rewrites.json`, which `golem generate` writes:

- [`golem build`](/reference/cli#build) checks your sources and emits JavaScript with the calls rewritten. It replaces `tsc -p`.
- The [Vite](/reference/runtime-api#vite) and [esbuild](/reference/runtime-api#esbuild) plugins rewrite the calls inside your bundler.
- The [Node loader](/reference/runtime-api#loader), `node --import @exprtlabs/golem/register`, rewrites them as Node loads TypeScript files.

All of them work on TypeScript 6 and 7. Run `golem generate`, or keep `golem watch` running, before a bundler build and in CI, so the index exists and matches your sources.

```sh
npm install --save-dev typescript@~7.0.2
```

`golem.yaml` names the project the build uses with [`tsconfig`](/reference/config#root-keys), the `tsconfig.json` beside it by default. Add the generated state to `.gitignore`:

```text
.golem/rewrites.json
.golem/build/
```

A NestJS app needs extra compiler settings ([NestJS setup](/guide/nestjs#set-up-typescript)).

## Run compiled code

- `"type": "module"` in `package.json`
- `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`
- target `ES2022` or newer for top-level `await`
- `.js` extensions on relative imports, including generated files
- `"outDir": ".build"`
- `"rootDir": "."`
- `@exprtlabs/*` package subpaths are ESM-only; import them from ESM application code, or invoke the CLI directly.

## Runtime dependencies

Validation is on and MobX is off by default.

| Setting in `golem.yaml` | Extra application dependencies |
| --- | --- |
| Validation on (`validation: true`) | `npm install ajv ajv-formats` |
| MobX on (`mobx: true`) | `npm install mobx` |
| Precompiled validators (`ajvStandalone: true`) | none; ship the generated validator JavaScript |
| Validation off (`validation: false`) | none |

These keys go at the top level of `golem.yaml` ([all settings](/reference/config#validation-profiles)).

## Add Golem to your project

Next, build your first model in the [quick start](/guide/quick-start).
