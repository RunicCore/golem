# Models

An offline task tracker built from golem models: one TypeScript declaration per concept becomes validation, JSON conversion and a class you extend. It needs no server, browser or network.

## What it shows

- `Task`: `IModel` fields, a generated base class with your own `toggle()`, and a priority that is a number in code and a word in JSON (`TSerde`).
- Tags and rules: built-in and generic tags, collection tags, a custom field rule, instance rules, server errors and a permission bit mask that is hexadecimal in JSON.
- Composition: nested and derived models, an assignee contact union, an open metadata model, and an attachment whose `Uint8Array` is base64 in JSON.
- Dates: a `Date` reminder and Temporal schedule fields.
- Money is a decimal string with an ISO 4217 currency code, never a float.

The example depends on `1.0.0-rc` of `@exprtlabs/golem*`, which is not published yet. Run it from this repository checkout: it resolves the packages from the root `node_modules`, so run `npm install` at the repository root first.

## Install and run

```sh
npm run generate   # write the generated model classes, for your editor
npm test           # offline: one case per feature; golem build generates first
npm start          # the walkthrough below
```

`npm start` prints:

```text
{ title: 'Review the draft', done: true, priority: 'normal' }
[]
saved task: { title: 'Ship the generators', done: true, priority: 'high' }
estimate: {"amount":"12.50","currency":"USD"}
assignee contact: phone
attachment: { name: 'checksum.bin', content: 'AQID' }
reminder: 2025-01-02T03:04:05.000Z
schedule ends: 2025-01-02T04:34:05Z
permission bits: 5
blank title: Enter a title.
```

## Files

| File | Responsibility |
| --- | --- |
| `src/task.model.ts`, `priority-word.ts` | The task and its priority word |
| `src/task-app.ts`, `read-json.ts`, `main.ts` | Create, validate and save a task; read it from JSON; the `npm start` entrypoint |
| `src/task-input.model.ts`, `task-input-rule.ts`, `task-input-checks.ts`, `title-rule.ts`, `server-errors.ts`, `load-task.ts` | A task form: field rule, instance rule, server errors, trusted conversion |
| `src/checklist-input.model.ts` | Checklist items with array-path errors |
| `src/builtin-tags.model.ts`, `tag-aliases.model.ts`, `collection-tags.model.ts` | Built-in, generic and collection tags |
| `src/permission-input.model.ts`, `permission-rules.ts` | A member's permission bits as a hexadecimal `TSerde` |
| `src/assignee.model.ts`, `contact.model.ts`, `metadata.model.ts` | Nested and derived models, the contact union, exact and open metadata |
| `src/comment.model.ts`, `estimate.model.ts`, `estimate-json.ts` | Plain-object `IObject` comments and a decimal-string estimate |
| `src/attachment.model.ts`, `attachment-json.ts`, `base64-codec.ts` | Attachments as base64 bytes |
| `src/reminder.model.ts`, `read-reminder.ts`, `schedule.model.ts`, `read-schedule.ts` | `Date` and Temporal fields |
| `src/app.test.ts` | One offline case per feature |

## Edit and regenerate

Change a model, then run `npm run generate`. The `*.model.generated.ts` files and `src/generated/` are replaced. They are not committed: `.gitignore` lists them with `.golem/`, and `npm run check` generates them before it type-checks.
