# ExprtLabs Golem

One TypeScript-first toolchain for models, validation, JSON conversion,
OpenAPI documents and typed API clients. Write the type once in
`@exprtlabs/golem-model`, `@exprtlabs/golem-openapi` or
`@exprtlabs/golem-ts-openapi`; the shared `@exprtlabs/golem` runtime and
`golem` CLI generate the rest, in dependency order when a project uses
more than one.

## Install

Use npm with Node.js 22.15 or newer. Put the runtime in application
dependencies, the generator in development dependencies, alongside the peer
compiler ([installation](docs/guide/install.md)):

```sh
npm install @exprtlabs/golem@rc ajv ajv-formats
npm install --save-dev @exprtlabs/golem-model@rc typescript@~7.0.2 ttsc@~0.30.4
```

Or, for an existing OpenAPI document:

```sh
npm install --save-dev @exprtlabs/golem-openapi@rc typescript@~7.0.2 ttsc@~0.30.4
```

Or, for NestJS controllers only:

```sh
npm install --save-dev @exprtlabs/golem-ts-openapi@rc typescript@~7.0.2 ttsc@~0.30.4
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
    "plugins": [{ "transform": "@exprtlabs/golem/ttsc-plugin" }]
  },
  "include": ["src/**/*.ts"]
}
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
import { TaskBase } from './task.model.generated.js';
import { toWireFormat } from '@exprtlabs/golem/serde';
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

- [What is Golem](docs/guide/index.md)
- [Installation](docs/guide/install.md)
- [Quick start](docs/guide/quick-start.md)
- [Configuration reference](docs/reference/config.md)

These pages build the docs site with VitePress. Read them here until a hosted
copy exists.

MIT License. Copyright (c) 2026 exprtlabs.ai.
