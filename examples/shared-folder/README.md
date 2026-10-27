# Shared folder

Two apps use one shared folder that declares a model. The web app checks its values and extends the model. The worker does not check them.

The example depends on `1.1.0-rc.0` of `@exprtlabs/golem*`. Run it from this repository checkout. It resolves the packages from the root `node_modules`, so run `npm install` at the repository root first.

## What it shows

- `shared/` declares the model `TCustomer` in `customer.model.ts`, with the plain types `TAddress` and `TMoney` and the rule function `isCurrencyCode`. It has a `package.json` without a `name` and no `golem.yaml`. It holds no class and no generated file.
- `apps/web` includes `../../shared` in its tsconfig. It has `validation: true`. Its class `Customer` extends `TCustomerBaseModel`, which it imports from its own `src/generated/models/shared/customer.model.generated.ts`, and adds `label()`.
- `apps/worker` reaches the folder through `apps/worker/shared`, a folder link to `../../shared`. It has `validation: false`. It reads and writes `TCustomer`. It imports no generated file: `golem build` adds that import.
- The link is not committed, because a symlink does not survive every checkout or archive. `npm run link-shared` makes it before `generate` and `test`, and `.gitignore` lists it.
- Each app generates the model in its own `models.output`, in a folder named for the shared package. Here that is `shared`, the top folder below the app root, because the `package.json` has no `name`. The shared folder stays as its author wrote it.
- An empty city and a currency that `isCurrencyCode` refuses fail in the web app. An empty city passes in the worker.
- [Share models between apps](../../docs/guide/shared-models.md) states the rules.

## Install and run

```sh
npm run generate   # make the folder link, then write the generated files, for your editor
npm run check      # generate, golem check for each app, then tsc for each app
npm test           # offline: golem build generates first, then each app runs its tests
```

## Files

| File | Responsibility |
| --- | --- |
| `shared/customer.model.ts`, `address.ts`, `money.ts`, `rules.ts` | The shared model, the plain types it uses and the currency rule |
| `apps/web/src/customer.ts`, `customers.ts`, `web.test.ts` | The web class of the customer, reading and writing it, and its tests |
| `apps/worker/src/customers.ts`, `worker.test.ts` | The worker's reading and writing of the customer, and its tests |
| `link-shared.js` | The script behind `npm run link-shared`: it makes the worker's folder link |
| `shared-folder.test.js` | The check that the shared folder holds only its own files after the builds |
| `apps/*/golem.yaml`, `apps/*/tsconfig.json` | The profile and the include of each app |
