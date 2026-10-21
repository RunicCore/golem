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
| `@exprtlabs/golem` | optional: `typescript` (`>=6.0.0 <8`) for `golem build`; `vite` (`>=5`) and `esbuild` for their plugins; `mobx`, `@nestjs/common`, `rxjs` for the features that use them |

## TypeScript setup

`golem build` compiles your project the way `tsc -p` does and rewrites `parse<T>()` on the way. `golem generate` writes the generated code that your editor and bundler need.

`parse<T>`, `stringify<T>`, `fromWireFormat<T>`, `toWireFormat<T>`, `validate<T>` and `assertValue<T>` are rewritten at build time to call the generated conversion. `tsc` doesn't do that, so an untransformed call throws at runtime. Build with one of these hosts:

- [`golem build`](/reference/cli#build) generates first, checks your sources and emits JavaScript with the calls rewritten. It replaces `tsc -p`, and a fresh clone builds with this one command.
- The [Vite](/reference/runtime-api#vite) and [esbuild](/reference/runtime-api#esbuild) plugins rewrite the calls inside your bundler.
- The [Node loader](/reference/runtime-api#loader), `node --import @exprtlabs/golem/register`, rewrites them as Node loads TypeScript files.

All four hosts are fully supported on TypeScript 6 and 7. Extra speed work, such as faster transforms in a Vite dev server, comes later and never changes what a host produces.

The plugins and the loader open your project from `golem.yaml`: the `config` option of the plugin, else the `GOLEM_CONFIG` environment variable, else `./golem.yaml`. They read each file themselves. A call that no host can rewrite fails with its file, its line and what to run, and `golem check` reports the same sites. Run `golem generate` once, or keep `golem watch` running, so your editor sees the generated files ([Generate, watch and check](/guide/watch)).

```sh
npm install --save-dev typescript@~7.0.2
```

`golem.yaml` names the project the build uses with [`tsconfig`](/reference/config#root-keys), the `tsconfig.json` beside it by default. Ignore the generated files and `.golem/` together, or commit the generated files with `.golem/outputs.json` and `.golem/codec-keys.json`. Always ignore `.golem/jobs.json` and `.golem/build/` ([what to commit](/reference/generated-files#gitignore)):

```text
.golem/
*.generated.ts
src/generated/
```

A model suffix such as `.entity.mts` makes `.generated.mts` files; add a line for each extension your suffixes use.

A NestJS app needs extra compiler settings ([NestJS setup](/guide/nestjs#set-up-typescript)).

## Run compiled code

- `"type": "module"` in `package.json`
- `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`, or `"module": "ESNext"` and `"moduleResolution": "Bundler"`
- target `ES2022` or newer for top-level `await`
- With NodeNext, `.js` extensions on relative imports, including generated files. With Bundler resolution, imports with no extension: `golem build` adds the full file name to the JavaScript it writes ([import paths](/reference/cli#import-paths))
- `"outDir": ".build"`
- `"rootDir": "."`
- `@exprtlabs/*` package subpaths are ESM-only; import them from ESM application code, or invoke the CLI directly.

## Runtime dependencies

Validation is on and MobX is off by default.

| Setting in `golem.yaml` | Extra application dependencies |
| --- | --- |
| Validation on (`validation: true`) | none |
| MobX on (`mobx: true`) | `npm install mobx` |
| Validation off (`validation: false`) | none |

These keys go at the top level of `golem.yaml` ([all settings](/reference/config#validation-profiles)).

## Add Golem to your project

Next, build your first model in the [quick start](/guide/quick-start).
