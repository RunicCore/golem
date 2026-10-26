# Install

Install the packages that each generator needs, with their peer dependencies and project settings.

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | `22.15` or newer |
| `typescript` | `>=6.0.0 <7` or `>=7.1.0-0 <8` |

The Node loader needs `--experimental-strip-types` before Node.js 22.18 ([Node versions](/guide/build#node-versions)).

Golem uses the `typescript` installed in your project. Generation writes the same files on TypeScript 6.0+ and 7.1+.

## Packages for each generator

Each generator is a development dependency:

| To generate | Development dependency |
| --- | --- |
| TypeScript models | `npm install --save-dev @exprtlabs/golem-model` |
| An OpenAPI client | `npm install --save-dev @exprtlabs/golem-openapi` |
| OpenAPI from NestJS controllers | `npm install --save-dev @exprtlabs/golem-ts-openapi` |

Generated models and clients import the runtime:

```sh
npm install @exprtlabs/golem
```

Generating OpenAPI from controllers needs no runtime. A NestJS app that registers `NestModelInterceptor` does need it.

The `golem` command comes from `@exprtlabs/golem`, which every generator depends on:

- Install it in the project before you run `npx golem`. An unrelated npm package is also named `golem`.
- Without a local install, `npx` offers to download and run that package. In CI, `npx` runs it without asking.
- In scripts and CI, run `npx --no-install golem`. It fails instead of running the other package.

The `@exprtlabs/*` package subpaths are ESM-only. Import them from ESM application code, or invoke the CLI directly.

## Peer dependencies

The generators declare the compiler as a peer dependency, so npm installs one copy in your project:

| Package | Peer dependencies |
| --- | --- |
| `@exprtlabs/golem-model` | `typescript` `>=6.0.0 <7` or `>=7.1.0-0 <8` |
| `@exprtlabs/golem-ts-openapi` | `typescript` `>=6.0.0 <7` or `>=7.1.0-0 <8` |
| `@exprtlabs/golem-openapi` | none, add `typescript` to compile the SDK |

`@exprtlabs/golem` has only optional peer dependencies:

- `typescript` `>=6.0.0 <7` or `>=7.1.0-0 <8`, for `golem build`, the plugins and the loader
- `vite` `>=5`, for the Vite plugin
- `esbuild` `^0.25.12`, for the esbuild plugin
- `mobx` `^6.13.0`, for MobX models
- `@nestjs/common` `^11.0.0` and `rxjs` `^7.8.0`, for `NestModelInterceptor`

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

`golem.yaml` names the project with [`tsconfig`](/reference/config#root-keys), the `tsconfig.json` beside it by default. A NestJS app needs more compiler settings ([set up TypeScript](/guide/nestjs-requests#set-up-typescript)). Choose how the build rewrites your calls in [Build your app](/guide/build).

## Runtime dependencies

Validation is on and MobX is off by default.

| Setting in `golem.yaml` | Extra application dependencies |
| --- | --- |
| Validation on (`validation: true`) | none |
| MobX on (`mobx: true`) | `npm install mobx` |
| Validation off (`validation: false`) | none |

These keys go at the top level of `golem.yaml` ([all settings](/reference/config#validation-profiles)). Build your first model in the [quick start](/guide/quick-start).
