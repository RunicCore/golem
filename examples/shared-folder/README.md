# Shared folder

Two apps use one folder of plain types. The web app checks its values. The worker does not.

The example depends on `1.0.0-rc` of `@exprtlabs/golem*`, which is not published yet. Run it from this repository checkout. It resolves the packages from the root `node_modules`, so run `npm install` at the repository root first.

## What it shows

- `shared/` holds plain types (`TMoney`, `TAddress`, `TCustomer`) and the rule function `isCurrencyCode`. It has a `package.json` without a `name` and no `golem.yaml`. It has no `IObject` or `IModel`, so golem writes nothing into it.
- `apps/web` includes `../../shared` in its tsconfig. It has `mobx: true` and `validation: true`. Its `TOrder` is a top-level `IObject` that uses `TCustomer`, `TMoney` and a plain line type as fields.
- `apps/worker` reaches the folder through `apps/worker/shared`, a folder link to `../../shared`. It has `validation: false`. Its `TWorkerCustomer` is a top-level `IObject` over `TCustomer`.
- Each app runs the same plain types with its own profile. An empty city and a currency that `isCurrencyCode` refuses fail in the web app. An empty city passes in the worker.
- Golem generates only for a model file inside the root of the app, so a shared folder works like an installed package. [Configuration](../../docs/reference/config.md#a-folder-shared-by-several-apps) states the rule.

## Install and run

```sh
npm run generate   # write the generated files, for your editor
npm test           # offline: golem build generates first, then each app runs its tests
```

## Files

| File | Responsibility |
| --- | --- |
| `shared/money.ts`, `customer.ts`, `address.ts`, `rules.ts` | The shared plain types and the currency rule |
| `apps/web/src/order.model.ts`, `orders.ts`, `web.test.ts` | The order of the web app, reading and writing it, and its tests |
| `apps/worker/src/customer.model.ts`, `customers.ts`, `worker.test.ts` | The customer of the worker, reading and writing it, and its tests |
| `shared-folder.test.js` | The check that the shared folder holds only its own files after the builds |
| `apps/*/golem.yaml`, `apps/*/tsconfig.json` | The profile and the include of each app |
