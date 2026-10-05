# ExprtLabs Golem

One toolchain for a TypeScript app's API contract, end to end. Write models
as TypeScript types; Golem generates validation, JSON conversion, OpenAPI
documents and typed API clients from them. Tags on a field's type, such as
`string & MinLength<2>` or `TSerde<typeof encode, typeof decode>`, drive both
its validation and its JSON form.

Start from what you have: TypeScript models (`@exprtlabs/golem-model`), an
OpenAPI document (`@exprtlabs/golem-openapi`) or NestJS controllers
(`@exprtlabs/golem-ts-openapi`). The shared `@exprtlabs/golem` runtime and
`golem` CLI run them in dependency order when a project uses more than one.
Golem runs on TypeScript 6 or 7; `golem build`, a Vite or esbuild plugin, or a
Node loader turns `parse<T>()` calls into generated code.

## Install

Use npm with Node.js 22.15 or newer. Put the runtime in application
dependencies, the generator in development dependencies, alongside the peer
compiler ([installation](docs/guide/install.md)):

```sh
npm install @exprtlabs/golem@rc ajv ajv-formats
npm install --save-dev @exprtlabs/golem-model@rc typescript@~7.0.2
```

Or, for an existing OpenAPI document:

```sh
npm install --save-dev @exprtlabs/golem-openapi@rc typescript@~7.0.2
```

Or, for NestJS controllers only:

```sh
npm install --save-dev @exprtlabs/golem-ts-openapi@rc typescript@~7.0.2
```

## Quick start

Add `"type": "module"` to `package.json` and this to `tsconfig.json`:
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
  "include": ["src/**/*.ts"]
}
```
and this to `golem.yaml`:
```yaml
version: 1
models:
  root: .
```
Declare a model in `src/task.model.ts`, generate its class, then use it:
```ts
import type { IModel } from '@exprtlabs/golem/model';
export type TTask = IModel<{ title: string; done: boolean }>;
```
```sh
npx golem generate
```
```ts
import { TTaskBaseModel } from './task.model.generated.js';
import { toWireFormat } from '@exprtlabs/golem/serde';
export class Task extends TTaskBaseModel {
  toggle(): void { this.done = !this.done; }
}
const task = new Task({ title: 'Review the draft', done: false });
task.toggle();
console.log(toWireFormat<Task>(task));
// { title: 'Review the draft', done: true }
```
Run it: `npx golem build && node .build/src/main.js`. `golem build` compiles
your project the way `tsc -p` does and rewrites `parse<T>()` on the way; it
generates first, so `golem generate` is for your editor. Ignore the generated
files with `.golem/`, `*.generated.ts` and `src/generated/` in `.gitignore`, or
commit them with `.golem/outputs.json` and `.golem/codec-keys.json`. Full setup: [Quick start](docs/guide/quick-start.md).

## More

- [What is Golem](docs/guide/index.md)
- [Installation](docs/guide/install.md)
- [Quick start](docs/guide/quick-start.md)
- [Configuration reference](docs/reference/config.md)

These pages build the docs site with VitePress. Read them here until a hosted
copy exists.

MIT License. Copyright (c) 2026 exprtlabs.ai.
