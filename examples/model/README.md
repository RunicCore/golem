# Model example

This complete project defines task, money, contact and order models, converts them to and from JSON, and validates them.

- Models are `IObject` and `IModel` declarations; `golem generate` writes the generated classes your classes extend.
- `toWireFormat`, `fromWireFormat` and `parse` convert synchronously, including custom conversions such as the priority number that is a word in JSON.
- Tags, field rules and instance rules produce validation issues; `getValidator` keeps stateful errors.
- Dates use `Date` and Temporal values.
- The project runs offline: the profile has validation on and MobX off.

It backs the guide pages [Quick start](../../docs/guide/quick-start.md), [Defining models](../../docs/guide/models.md), [Composing models](../../docs/guide/model-composition.md), [Type tags](../../docs/guide/tags.md), [Serialization](../../docs/guide/serialization.md), [Validation](../../docs/guide/validation.md), [Dates and times](../../docs/guide/dates.md) and [MobX and React](../../docs/guide/mobx.md), and the [runtime API](../../docs/reference/runtime-api.md).

## Install and run

Use Node.js 22.15 or newer. The `package.json` pins `@exprtlabs/golem` and the generator packages at `1.0.0-rc`, so `npm install` fetches the release-candidate packages from the registry until they are published.

```sh
npm install
npm run generate
npm test
npm start
```

- `npm run generate` runs the `models` job in `golem.yaml`.
- `npm test` checks the generated files, compiles with `ttsc` and runs `src/app.test.ts`.
- `npm start` creates a task, toggles it, validates and serializes it, and prints the saved JSON.

Edit authored files and run `npm run generate` again. The `*.model.generated.ts` files and `src/generated/` are replaced.

## Source files

| File | Responsibility |
| --- | --- |
| `src/task.model.ts`, `src/task-input.model.ts` | Task model and its input declaration |
| `src/money.model.ts`, `src/customer.model.ts`, `src/contact.model.ts`, `src/order-input.model.ts` | Nested and composed models |
| `src/builtin-tags.model.ts`, `src/collection-tags.model.ts`, `src/tag-aliases.model.ts`, `src/permission-input.model.ts` | Tag examples |
| `src/title-rule.ts`, `src/task-input-rule.ts`, `src/task-input-checks.ts`, `src/permission-rules.ts` | Field and instance rules |
| `src/priority-word.ts`, `src/base64-codec.ts`, `src/attachment.model.ts` | Custom conversions |
| `src/schedule.model.ts`, `src/reminder.model.ts` | Date and Temporal fields |
| `src/open-objects.model.ts`, `src/note.model.ts` | Exact and open models |
| `src/read-json.ts`, `src/money-json.ts`, `src/attachment-json.ts`, `src/read-schedule.ts`, `src/read-reminder.ts`, `src/load-task.ts`, `src/server-errors.ts` | Short usage snippets the guides quote |
| `src/task-app.ts`, `src/main.ts` | Create, validate and save a task; the `npm start` entrypoint |
| `src/quick-start/` | The model from the Quick start page |
| `src/app.test.ts` | Tests for every behavior above |
