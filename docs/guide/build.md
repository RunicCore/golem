# Build your app

Choose and set up the build host that rewrites `parse<T>` and five other calls.

## Why a host is needed

`parse<T>`, `stringify<T>`, `toWireFormat<T>`, `fromWireFormat<T>`, `validate<T>` and `assertValue<T>` take a type argument. TypeScript erases that argument at run time. A host is a tool that compiles or loads your TypeScript. It reads each of these calls with your project's TypeScript and replaces the call with a call to the generated code. `tsc` does not rewrite these calls.

A call that no host rewrote throws a `LibError` of kind `ValidationUnavailable` (`validation_unavailable`). The message starts with the name of the call, as in `parse<T> was not rewritten to a generated function`. It then lists the hosts that rewrite the call.

A call that no host can rewrite fails the build with its file, its line and what to run. `golem check` reports the same calls.

Generated classes and `validateInstance` work without a host.

## Choose a host

| Host | Use it when | Setup |
| --- | --- | --- |
| [`golem build`](#build-with-golem-build) | You compile with `tsc` and run the JavaScript | Replace `tsc -p` |
| [Vite plugin](#vite) | Vite bundles your app | `golem()` in `plugins` |
| [esbuild plugin](#esbuild) | esbuild bundles your app | `golem()` in `plugins` |
| [Node loader](#node-loader) | Node runs your TypeScript files | `--import` flag |

Every host works with TypeScript 6 and 7 and produces the same rewrite.

The plugins and the loader open your project from `golem.yaml`:

- A plugin uses its `config` option first. Then it reads the `GOLEM_CONFIG` environment variable, then it opens `./golem.yaml`.
- The loader reads `GOLEM_CONFIG`, then `./golem.yaml`.

The plugins and the loader scan your files themselves. They need the generated files to exist. Run `golem generate` once before you use them.

## Node versions

Golem needs Node.js 22.15 or newer ([requirements](/guide/install#requirements)). The flags that each host needs depend on the Node.js version:

| Node.js version | `golem build` | Vite and esbuild plugins | Node loader |
| --- | --- | --- | --- |
| 22.15 to 22.17 | No flag | No flag | Add `--experimental-strip-types` |
| 22.18 or newer | No flag | No flag | No flag |

`golem build` writes JavaScript, and the plugins run inside Vite or esbuild, which strip the types. Only the loader gives TypeScript files to Node.

## Build with golem build

```sh
npx golem build
```

`golem build` generates first and type-checks your sources with the TypeScript in your project. It starts no `tsc` process. Then it writes JavaScript with the calls rewritten into `outDir`. A fresh clone builds with this one command. Run the result with Node:

```sh
node .build/src/main.js
```

The build needs a `golem.yaml` and a tsconfig with `outDir`. Use the [project settings](/guide/install#project-settings).

- It prints type errors as `tsc -p` does. It uses colors and a `Found N errors` line when the `pretty` option is true, or when stdout is a terminal and `NO_COLOR` is not set.
- A failed check still writes JavaScript, unless `noEmitOnError` is true. The exit status is not `0` after a failed check.
- It writes an output file only when the file changes. A build with nothing changed writes no file.
- `--listFiles` prints the files of the program. `--generateTrace`, `--extendedDiagnostics`, `--explainFiles`, `--traceResolution` and `--diagnostics` stop the build with a message, also when the tsconfig sets them. Run `tsc -p <tsconfig> --noEmit` with the option instead.
- Do not run `tsc -p` without `--noEmit` on the same project. It writes JavaScript with no rewrite into the same `outDir`.

The options, the import paths that the build changes and the compiler arguments that it passes on are in the [CLI reference](/reference/cli#build).

## Vite

<<< ../../examples/payments/vite.config.ts#vite-config

- `golem()` rewrites each TypeScript module in memory before Vite strips its types. This holds in the dev server and in builds.
- Put `golem()` before plugins that transform TypeScript.
- The `config` option is optional. It names the `golem.yaml` relative to the Vite root. Without it, the plugin reads `GOLEM_CONFIG`, then `./golem.yaml`.
- While you run [`golem watch`](/guide/watch#watch), the dev server transforms again only the modules whose rewrite changed.

## esbuild

<<< ../../examples/models/bundle.mjs#esbuild-bundle{js}

- `golem()` rewrites each TypeScript file in memory before esbuild strips its types.
- It takes each TypeScript file outside `node_modules` that holds a call to rewrite. Other files go to the next plugins.
- A workspace package that is linked into `node_modules` counts as outside it, also with `preserveSymlinks`. `golem build` does not build such a package, with or without `preserveSymlinks`: its own `golem build` builds it.
- A plugin that needs a file that `golem()` takes goes before `golem()` in `plugins`.
- `config` names the `golem.yaml` relative to `absWorkingDir`.

## Node loader

```sh
node --import @exprtlabs/golem/register src/main.ts
```

- The loader rewrites TypeScript files as Node loads them.
- The loader also loads `.tsx` files. The `jsx` options of your tsconfig set their output.
- Run `golem generate` once, so the generated files exist.
- The loader needs ES modules. Use `"type": "module"` or `.mts` files.
- Node before 22.18 needs `--experimental-strip-types` as well ([Node versions](#node-versions)).
- The loader compiles the files that Node cannot strip, such as a file with a decorator or an `enum`, with your TypeScript. A NestJS app needs no second loader ([run with the Node loader](/guide/nestjs-requests#run-with-the-node-loader)).

## Lint for unrewritable calls {#lint}

A host rewrites each call that it can read. It cannot rewrite `parse<TPayment>` used as a value, such as `texts.map(parse<TPayment>)`. That code throws when it runs. `golem build` and `golem check` report it. The ESLint rule `golem/unrewritable-serde-call` reports the same errors when ESLint runs, also in your editor.

```js
// eslint.config.mjs
import { golem } from '@exprtlabs/golem/eslint';
import tseslint from 'typescript-eslint';

export default [...tseslint.configs.base, await golem()];
```

- `golem()` returns one flat-config object. It turns the rule on for `.ts`, `.mts`, `.cts` and `.tsx` files.
- The rule needs a parser that reads TypeScript. Set it in a config object before `golem()`.
- The rule reads your `golem.yaml` and your `tsconfig.json`, as the hosts do. The `config` option names another `golem.yaml`, and `cwd` sets the folder where the search starts. Without them, `golem()` reads `GOLEM_CONFIG`, then `./golem.yaml` in the working directory.
- Run `golem generate` first, so the generated files exist.
- A report names the code, such as `RUNM1079`, and the position. The [diagnostics](/reference/diagnostics) page gives the fix for each code.

## Editor setup (generate or watch)

A host rewrites calls. It does not give your editor the generated files. Run `npx golem generate` once, or keep `npx golem watch` running ([Generate, watch and check](/guide/watch)). The editor then sees `TTaskBaseModel` and the other generated names.

## Build in CI

```sh
npx --no-install golem build
```

`golem build` generates first, so a clone needs no committed generated files. With `--no-install`, `npx` fails when the project does not [install Golem](/guide/install#packages-for-each-generator). [`golem check`](/guide/watch#check-without-writing) reports stale generated files without writing.
