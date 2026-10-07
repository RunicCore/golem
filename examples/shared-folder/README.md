# Shared folder

Two apps use one folder of models. The web app checks its values. The worker does not.

The example depends on `1.0.0-rc` of `@exprtlabs/golem*`, which is not published yet. Run it from this repository checkout. It resolves the packages from the root `node_modules`, so run `npm install` at the repository root first.

## What it shows

- `shared/` holds `TMoney` and `TCustomer` as `IObject` models and a plain `TAddress` type. It has a `package.json` with a `name` and no `golem.yaml`.
- `apps/web` includes `../../shared` in its tsconfig. It has `mobx: true` and `validation: true`. Its `TOrder` is a top-level `IObject` that uses `TCustomer`, `TMoney` and a plain line type as fields.
- `apps/worker` reaches the folder through `apps/worker/shared`, a folder link to `../../shared`. It has `validation: false`.
- Each app writes its own layer and runs the same shared models with its own profile. An empty city fails in the web app and passes in the worker.
- Golem writes no models for a package in `node_modules`, and a package ships no generated code. An app declares the `IObject` or `IModel` at the top level in its own source. The plain types inside it need no alias. [Configuration](../../docs/reference/config.md#a-folder-shared-by-several-apps) states the rule.

## Install and run

```sh
npm run generate   # write the generated files, for your editor
npm test           # offline: golem build generates first, then each app runs its tests
```

## Files

| File | Responsibility |
| --- | --- |
| `shared/money.model.ts`, `customer.model.ts`, `address.ts` | The shared models and the plain address type |
| `apps/web/src/order.model.ts`, `orders.ts`, `web.test.ts` | The order of the web app, reading and writing it, and its tests |
| `apps/worker/src/customers.ts`, `worker.test.ts` | The worker's reading and writing of a customer, and its tests |
| `apps/*/golem.yaml`, `apps/*/tsconfig.json` | The profile and the include of each app |
