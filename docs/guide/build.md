# Build your app

Choose and set up the build host that rewrites `parse<T>` and five other calls.

## Why a host is needed

`parse<T>`, `stringify<T>`, `toWireFormat<T>`, `fromWireFormat<T>`, `validate<T>` and `assertValue<T>` take a type argument. TypeScript erases that argument at run time. A host is a tool that compiles or loads your TypeScript. It reads each of these calls with your project's TypeScript and replaces the call with a call to the generated code. `tsc` does not rewrite these calls.

A call that no host rewrote throws `parse<T> was not rewritten to a generated function`. A call that no host can rewrite fails the build with its file, its line and what to run. `golem check` reports the same calls.

Generated classes and `validateInstance` work without a host.

## Choose a host

| Host | Use it when | Setup |
| --- | --- | --- |
| [`golem build`](#build-with-golem-build) | You compile with `tsc` and run the JavaScript | Replace `tsc -p` |
| [Vite plugin](#vite) | Vite bundles your app | `golem()` in `plugins` |
| [esbuild plugin](#esbuild) | esbuild bundles your app | `golem()` in `plugins` |
| [Node loader](#node-loader) | Node runs your TypeScript files | `--import` flag |

Every host works with TypeScript 6 and 7 and produces the same rewrite.

The plugins and the loader open your project from `golem.yaml`. A plugin uses its `config` option first. Then it reads the `GOLEM_CONFIG` environment variable, then it opens `./golem.yaml`. The loader reads `GOLEM_CONFIG`, then `./golem.yaml`.

The plugins and the loader scan your files themselves. They need the generated files to exist. Run `golem generate` once before you use them.

## Build with golem build

```sh
npx golem build
```

`golem build` generates first and type-checks your sources with the TypeScript in your project. Then it writes JavaScript with the calls rewritten into `outDir`. A fresh clone builds with this one command. Run the result with Node:

```sh
node .build/src/main.js
```

The build needs a `golem.yaml` and a tsconfig with `outDir`. Use the [project settings](/guide/install#project-settings). The options, the import paths that the build changes and the compiler arguments that it passes on are in the [CLI reference](/reference/cli#build).

## Vite

<<< ../../examples/payments/vite.config.ts#vite-config

`golem()` rewrites each TypeScript module in memory before Vite strips its types, in the dev server and in builds. Put it before plugins that transform TypeScript. The `config` option is optional. It names the `golem.yaml` relative to the Vite root. Without it, the plugin reads `GOLEM_CONFIG`, then `./golem.yaml`. While you run [`golem watch`](/guide/watch#watch), the dev server transforms again only the modules whose rewrite changed.

## esbuild

<<< ../../examples/models/bundle.mjs#esbuild-bundle{js}

`golem()` rewrites each TypeScript file in memory before esbuild strips its types. It takes each TypeScript file outside `node_modules` that holds a call to rewrite. Other files go to the next plugins. A plugin that needs a file that `golem()` takes goes before `golem()` in `plugins`. `config` names the `golem.yaml` relative to `absWorkingDir`.

## Node loader

```sh
node --import @exprtlabs/golem/register src/main.ts
```

The loader rewrites TypeScript files as Node loads them. Run `golem generate` once, so the generated files exist. The loader needs ES modules, so use `"type": "module"` or `.mts` files. Node before 22.18 needs `--experimental-strip-types` as well. A NestJS app needs a second loader that compiles decorators ([set up TypeScript](/guide/nestjs-requests#set-up-typescript)).

## Editor setup (generate or watch)

A host rewrites calls. It does not give your editor the generated files. Run `npx golem generate` once, or keep `npx golem watch` running ([Generate, watch and check](/guide/watch)). The editor then sees `TTaskBaseModel` and the other generated names.

## Build in CI

```sh
npx --no-install golem build
```

`golem build` generates first, so a clone needs no committed generated files. With `--no-install`, `npx` fails when the project does not [install Golem](/guide/install#packages-for-each-generator). [`golem check`](/guide/watch#check-without-writing) reports stale generated files without writing.
