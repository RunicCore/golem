# Model with MobX example

This complete project makes a generated model observable with MobX.

- `asGenObservable(this, { ... })` annotates the declared fields; `label` is computed and `toggle` is an action.
- An `autorun` reaction logs the label as the task changes, and is disposed.
- `toWireFormat` and `fromWireFormat` convert between an observable task and JSON.
- The project runs offline: the profile has MobX on and validation off.

It backs the guide page [MobX and React](../../docs/guide/mobx.md) and the [`@exprtlabs/golem/mobx` reference](../../docs/reference/runtime-api.md#mobx).

## Install and run

Use Node.js 22.15 or newer. The `package.json` pins `@exprtlabs/golem` and the generator packages at `1.0.0-rc`, so `npm install` fetches the release-candidate packages from the registry until they are published.

```sh
npm install
npm run generate
npm test
npm start
```

- `npm test` checks the generated files, compiles with `ttsc` and runs `src/app.test.ts`.
- `npm start` toggles a task under an `autorun` and prints each label and the saved JSON.

Edit authored files and run `npm run generate` again. `src/task.model.generated.ts` is replaced.

## Source files

| File | Responsibility |
| --- | --- |
| `src/task.model.ts` | Model declaration and the observable `Task` class |
| `src/observe-task.ts` | Reaction that logs the label |
| `src/task-app.ts` | Create and serialize a task |
| `src/main.ts` | The `npm start` entrypoint |
| `src/app.test.ts` | Tests for observability, disposal and conversion |
