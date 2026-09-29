# ExprtLabs Codegen

One TypeScript-first toolchain for models, validation, JSON conversion,
OpenAPI documents and typed API clients. Write the type once in
`@exprtlabs/model-codegen`, `@exprtlabs/openapi-to-ts` or
`@exprtlabs/ts-to-openapi`; the shared `@exprtlabs/codegen` runtime and
`runic-codegen` CLI generate the rest, in dependency order when a project uses
more than one.

## Install

Use npm with Node.js 22.12 or newer. Put the runtime in application
dependencies, the generator in development dependencies, alongside the peer
compiler ([installation](docs/guide/install.md)):

```sh
npm install @exprtlabs/codegen@rc ajv ajv-formats
npm install --save-dev @exprtlabs/model-codegen@rc typescript@~7.0.2 ttsc@~0.30.4
```

Or, for an existing OpenAPI document:

```sh
npm install --save-dev @exprtlabs/openapi-to-ts@rc typescript@~7.0.2 ttsc@~0.30.4
```

Or, for NestJS controllers only:

```sh
npm install --save-dev @exprtlabs/ts-to-openapi@rc typescript@~7.0.2 ttsc@~0.30.4
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
    "outDir": ".build",
    "plugins": [{ "transform": "@exprtlabs/codegen/ttsc-plugin" }]
  },
  "include": ["src/**/*.ts"]
}
```
Declare a model in `src/task.model.ts`, generate its class, then use it:
```ts
import type { IModel } from '@exprtlabs/codegen/model';
export type TTask = IModel<{ title: string; done: boolean }>;
```
```sh
npx runic-codegen generate
```
```ts
import { TaskBase } from './task.model.generated.js';
import { toWireFormat } from '@exprtlabs/codegen/serde';
export class Task extends TaskBase {
  toggle(): void { this.done = !this.done; }
}
const task = new Task({ title: 'Review the draft', done: false });
task.toggle();
console.log(toWireFormat<Task>(task));
// { title: 'Review the draft', done: true }
```
Run it: `npx ttsc && node .build/src/main.js`. Full setup: [Quick start](docs/guide/quick-start.md).

## More

- [What is Codegen](docs/guide/index.md)
- [Installation](docs/guide/install.md)
- [Quick start](docs/guide/quick-start.md)
- [Configuration reference](docs/reference/config.md)

These pages build the docs site with VitePress. Read them here until a hosted
copy exists.

MIT License. Copyright (c) 2026 exprtlabs.ai.
