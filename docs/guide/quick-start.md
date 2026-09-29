# Quick start

Declare a model, generate its class, add a method, and run it.

## Install

```sh
npm install @exprtlabs/codegen@rc ajv ajv-formats
npm install --save-dev @exprtlabs/model-codegen@rc typescript@~7.0.2 ttsc@~0.30.4
```

Add `"type": "module"` to `package.json` and this to `tsconfig.json` ([TypeScript setup](/guide/install#typescript-setup)):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": ".",
    "outDir": ".build",
    "plugins": [
      { "transform": "@exprtlabs/codegen/ttsc-plugin" }
    ]
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

## Declare your fields

Mark a type with `IModel` in `src/task.model.ts`:

```ts
import type { IModel } from '@exprtlabs/codegen/model';

export type TTask = IModel<{
  title: string;
  done: boolean;
}>;
```

The generator reads `src/**/*.model.ts` and `src/**/*.models.ts`; [`models.sources`](/reference/config#typescript-models) changes that.

An `IObject` gives plain objects with the same validation and conversion; an `IModel` also gives you a class ([IObject or IModel](/guide/models#iobject-or-imodel)).

## Generate the base

Add `runic-codegen.yaml` at the project root and run the generator:

```yaml
version: 1
models:
  root: .
```

```sh
npx runic-codegen generate
```

```
Generated configured outputs.
```

You get `src/task.model.generated.ts` beside the declaration, with the generated class `TaskBase` and the `TaskFields` type. Shared files go to `models.output` (default `src/generated/models/`).

## Add methods

Extend the generated class in the same file:

```ts
import { TaskBase } from './task.model.generated.js';

export class Task extends TaskBase {
  toggle(): void {
    this.done = !this.done;
  }
}
```

To add a field later, change `TTask` and generate again. Only `task.model.generated.ts` is replaced; `toggle()` stays.

## Use the model

Create `src/main.ts`:

```ts
import { toWireFormat } from '@exprtlabs/codegen/serde';
import { validateInstance } from '@exprtlabs/codegen/validation';
import { Task } from './task.model.js';

const task = new Task({ title: 'Review the draft', done: false });
task.toggle();
console.log(toWireFormat<Task>(task)); // { title: 'Review the draft', done: true }
console.log(await validateInstance(task)); // []
```

`parse<Task>(text)` builds a `Task`; `parse<TTask>(text)` returns a plain object. `stringify` returns JSON text.

## Run it

```sh
npx ttsc && node .build/src/main.js
```

```
{ title: 'Review the draft', done: true }
[]
```
