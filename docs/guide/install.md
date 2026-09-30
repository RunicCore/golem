# Installation

Install the generator you need as a development dependency and the shared runtime as an application dependency.

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | `22.15` or newer |
| `typescript` | `~7.0.2` |
| `ttsc` | `~0.30.4` |

TypeScript 5 and 6 aren't supported.

## Packages per generator

The `golem` command comes from `@exprtlabs/golem`, which every generator depends on. If `npx golem` isn't found, add `@exprtlabs/golem` as a direct dependency.

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
| `@exprtlabs/golem-model` | `typescript` `~7.0.2`, `ttsc` `~0.30.4` |
| `@exprtlabs/golem-ts-openapi` | `typescript` `~7.0.2`, `ttsc` `~0.30.4` |
| `@exprtlabs/golem-openapi` | none; add `typescript` and `ttsc` to compile the SDK |
| `@exprtlabs/golem` | optional: `typescript` 7 and `ttsc` 0.30 for the plugin; `ajv`, `ajv-formats`, `mobx`, `esbuild`, `@nestjs/common`, `rxjs` for the features that use them |

## TypeScript setup

`parse<T>`, `stringify<T>`, `fromWireFormat<T>` and `toWireFormat<T>` need **TypeScript 7** and **`ttsc` 0.30**. `tsc` doesn't run the plugin, so an untransformed call throws at runtime.

```sh
npm install --save-dev typescript@~7.0.2 ttsc@~0.30.4
```

Add the plugin to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [
      { "transform": "@exprtlabs/golem/ttsc-plugin" }
    ]
  }
}
```

Compile with `npx ttsc`. `ttsc` builds the plugin on first use with the Go toolchain in its platform package. Keep optional dependencies enabled, or set `TTSC_GO_BINARY` to a Go 1.26 toolchain.

A NestJS app needs extra compiler settings ([NestJS setup](/guide/nestjs#set-up-typescript)).

## Run compiled code

- `"type": "module"` in `package.json`
- `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`
- target `ES2022` or newer for top-level `await`
- `.js` extensions on relative imports, including generated files
- `"outDir": ".build"`
- `"rootDir": "."`
- `@exprtlabs/*` package subpaths are ESM-only; import them from ESM application code, or invoke the CLI directly. `@exprtlabs/golem/ttsc-plugin` is CommonJS.

## Runtime dependencies

Validation is on and MobX is off by default.

| Setting in `golem.yaml` | Extra application dependencies |
| --- | --- |
| Validation on (`validation: true`) | `npm install ajv ajv-formats` |
| MobX on (`mobx: true`) | `npm install mobx` |
| Precompiled validators (`ajvStandalone: true`) | none; ship the generated validator JavaScript |
| Validation off (`validation: false`) | none |

These keys go at the top level of `golem.yaml` ([all settings](/reference/config#validation-profiles)).

## Add Codegen to your project

Next, build your first model in the [quick start](/guide/quick-start).
