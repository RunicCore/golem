# Quick start

Install Golem, declare a model, generate its class, add a method, and run it.

## Install

```sh
npm install @exprtlabs/golem
npm install --save-dev @exprtlabs/golem-model typescript@~7.1.0-beta
```

Check the [requirements](#requirements). Add `"type": "module"` to `package.json` and this to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": ".",
    "outDir": ".build"
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

## Declare your fields

`priority` is a number in your code and a word in JSON. A [`TSerde`](/guide/serialization#change-the-json-form) tag names the two functions that convert a field to and from its JSON form. First write them in `src/priority-word.ts`. The generated file imports them, so they cannot live in the model file:

<<< ../../examples/models/src/priority-word.ts#priority-word

Then mark a type with `IModel` in `src/task.model.ts`. The `TSerde` tag ties `priority` to those functions. `Integer`, `Minimum<1>` and `Maximum<3>` keep the number between 1 and 3, so a task with another priority fails validation:

<<< ../../examples/models/src/task.model.ts#task-declaration

The generator reads `src/**/*.model.ts` and `src/**/*.models.ts`. [`model.suffixes`](/reference/config#model-block) changes the endings and `model.sources` names the files.

Declare an `IObject` instead to keep plain objects ([IObject or IModel](/guide/models#iobject-or-imodel)).

## Generate the base

Add `golem.yaml` at the project root and run the generator. Your editor needs the generated code now. `golem build` generates it again later.

<<< ../../examples/models/golem.yaml

`model: {}` turns on the [models job](/reference/config#model-block) with its defaults.

```sh
npx golem generate
```

```
Generated configured outputs.
```

You get `src/task.model.generated.ts` beside the declaration, with the generated class `TTaskBaseModel` and the `TTaskFields` type. Shared files go to `model.output` (default `src/generated/models/`). You choose whether to commit the generated files ([commit or ignore them](/reference/generated-files#gitignore)).

## Add methods

Import `TTaskBaseModel` from the generated file and extend it in `src/task.model.ts`, below the declaration:

<<< ../../examples/models/src/task.model.ts#task-class

To add a field later, change `TTask` and generate again. Only `task.model.generated.ts` is replaced. `toggle()` stays.

## Use the model

Create `src/main.ts`:

<<< ../../examples/models/src/main.ts#use-task

`toWireFormat<Task>(task)` returns the JSON form of the task as an object. TypeScript erases the `<Task>` argument at run time, so a build tool must replace the call with generated code ([Build tools](/guide/build)). `@exprtlabs/golem/serde` also exports `parse` and `stringify`. `parse<Task>(text)` builds a `Task`. `parse<TTask>(text)` returns a plain object. `stringify` returns JSON text.

## Run it

```sh
npx golem build && node .build/src/main.js
```

```
Built tsconfig.json.
{ title: 'Review the draft', done: true, priority: 'normal' }
[]
```

`golem build` is a build tool. It generates first, checks your sources, and writes JavaScript into `.build/` with the `toWireFormat` call replaced by generated code. A bundler plugin or the Node loader can be the build tool instead ([Build tools](/guide/build)). Run `golem watch` to regenerate while you edit ([daily loop](/guide/watch)).

Your `main.ts` holds only the code above, so this is all it prints. The full example's `main.ts` continues with one line per feature. `npm start` in [`examples/models`](https://github.com/RunicCore/golem/tree/master/examples/models) prints them all.

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | `22.15` or newer |
| `typescript` | `>=6.0.0 <7` or `>=7.1.0-0 <8` |

The Node loader needs `--experimental-strip-types` before Node.js 22.18 ([Node versions](/guide/build#node-versions)).

Golem uses the `typescript` installed in your project. Generation writes the same files on TypeScript 6.0+ and 7.1+.

## Packages for each generator

Each generator is a development dependency. Install it with `typescript`, which none of them brings:

| To generate | Development dependency |
| --- | --- |
| TypeScript models | `npm install --save-dev @exprtlabs/golem-model typescript@~7.1.0-beta` |
| An OpenAPI to TypeScript SDK | `npm install --save-dev @exprtlabs/golem-openapi-ts typescript@~7.1.0-beta` |
| OpenAPI from NestJS controllers | `npm install --save-dev @exprtlabs/golem-ts-openapi typescript@~7.1.0-beta` |

Generated models and clients import the runtime:

```sh
npm install @exprtlabs/golem
```

Generating OpenAPI from controllers needs no runtime. A NestJS app that registers `NestModelInterceptor` does need it, so it lists `@exprtlabs/golem-ts-openapi` in `dependencies`.

An app with the [MobX extension](/reference/config#mobx-extension) imports `@exprtlabs/golem-openapi-ts` at run time, so it lists that package in `dependencies`, with `mobx`.

The `golem` command comes from `@exprtlabs/golem`, which every generator depends on:

- Install it in the project before you run `npx golem`. An unrelated npm package is also named `golem`.
- Without a local install, `npx` offers to download and run that package. In CI, `npx` runs it without asking.
- In scripts and CI, run `npx --no-install golem`. It fails instead of running the other package.

The `@exprtlabs/*` package subpaths are ESM-only. Import them from ESM application code, or invoke the CLI directly.

## Peer dependencies

`@exprtlabs/golem-model` declares the compiler as a peer dependency. The two OpenAPI packages declare it as an optional peer, and declare `@exprtlabs/golem` as a peer, so your project holds one copy of each:

| Package | Peer dependencies |
| --- | --- |
| `@exprtlabs/golem-model` | `typescript` `>=6.0.0 <7` or `>=7.1.0-0 <8` |
| `@exprtlabs/golem-ts-openapi` | `@exprtlabs/golem`, and `@exprtlabs/golem-model`, `typescript` `>=6.0.0 <7` or `>=7.1.0-0 <8`, `@nestjs/common` `^11.0.0` and `rxjs` `^7.8.0` (all four optional; the last two for `NestModelInterceptor`) |
| `@exprtlabs/golem-openapi-ts` | `@exprtlabs/golem`, and `@exprtlabs/golem-model`, `typescript` `>=6.0.0 <7` or `>=7.1.0-0 <8` and `mobx` `^6.13.0` (all three optional; `mobx` for the MobX extension) |

`@exprtlabs/golem` has only optional peer dependencies:

- `typescript` `>=6.0.0 <7` or `>=7.1.0-0 <8`, for `golem build`, the plugins and the loader
- `vite` `>=5`, for the Vite plugin
- `esbuild` `^0.25.12`, for the esbuild plugin
- `eslint` `^9.0.0 || ^10.0.0`, for the ESLint rule

```sh
npm install --save-dev typescript@~7.1.0-beta
```

## Project settings

- `"type": "module"` in `package.json`
- `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`, or `"module": "ESNext"` and `"moduleResolution": "Bundler"`
- target `ES2022` or newer for top-level `await`
- With NodeNext, `.js` extensions on relative imports, including generated files. With Bundler resolution, imports with no extension: `golem build` adds the full file name to the JavaScript it writes ([import paths](/reference/cli#import-paths))
- `"outDir": ".build"`
- `"rootDir": "."`

`golem.yaml` names the project with [`tsconfig`](/reference/config#root-keys), the `tsconfig.json` beside it by default. A NestJS app needs more compiler settings ([set up TypeScript](/guide/nestjs-requests#set-up-typescript)). Choose the build tool in [Build tools](/guide/build).

## Runtime dependencies

Validation is on and MobX is off by default. `validation` also takes `sanity`, which checks the shape only.

| Setting in `golem.yaml` | Extra application dependencies |
| --- | --- |
| Validation on (`validation: true`) | none |
| Shape checks only (`validation: sanity`) | none |
| MobX on (`extensions: { mobx: {} }` in the `openapi-ts` block) | `npm install mobx @exprtlabs/golem-openapi-ts` |
| Validation off (`validation: false`) | none |

`validation` goes at the top level of `golem.yaml` ([all settings](/reference/config#validation-profiles)). The MobX extension goes in the `openapi-ts` block ([MobX extension](/reference/config#mobx-extension)).
