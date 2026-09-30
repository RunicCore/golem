# Golem examples

Each directory is a complete TypeScript project with its source contract,
configuration, generated files and runnable entrypoint. Browse the folders below
in the [Golem repository](https://github.com/exprtlabs/codegen). The documentation
pages explain the examples and show source regions from these maintained files.

| Example | Profile | Shows |
| --- | --- | --- |
| [model](model/) | Validation on, MobX off | Model methods, synchronous serde and the stateful `getValidator` validator |
| [openapi](openapi/) | Validation on, MobX off | Typed operations, request arguments and responses |
| [combined](combined/) | Validation on, MobX off | Nested SDK types, stateless checks and application model rules |
| [model-mobx](model-mobx/) | Validation off, MobX on | Observable fields, actions and computed values |
| [combined-mobx](combined-mobx/) | Validation on, MobX on | Observable nested SDK models and stateful editor errors |
| [nest-openapi](nest-openapi/) | Validation on, MobX off | Nest interceptor, OpenAPI and SDK |
| [showcase](showcase/) | Validation on, MobX off | Custom number-to-hexadecimal conversion |
| [react-mobx](react-mobx/) | Validation on, MobX on | React form bound to an observable model editor, saved over the SDK |

The guides walk through them: [models](../docs/guide/models.md),
[an API client](../docs/guide/client.md),
[models with a client](../docs/guide/models-and-client.md),
[NestJS](../docs/guide/nestjs.md) and
[type tags](../docs/guide/tags.md#worked-example-permissions).

## Install and run

From the selected `examples/<name>/` directory in your checkout:

```sh
npm install
npm run generate
npm start
```

The package manifests use the release-candidate packages;
[Installation](../docs/guide/install.md) explains the `@rc` tag and profiles.

- `model` and `model-mobx` run with local data.
- `openapi` reads `TASKS_API_BASE_URL` and `combined` reads `PAYMENTS_API_BASE_URL`
  to call an existing API.
- `combined-mobx` calls a service only when `PAYMENTS_API_BASE_URL` is set.
- `nest-openapi` starts a local in-memory API; use `npm run client` in a second
  terminal.
- `showcase` runs offline and can call its optional adapter when
  `PROJECT_ACCESS_API_BASE_URL` is set.
- `react-mobx` runs with `npm run dev`. It reads `VITE_API_BASE_URL` in the
  browser and `PAYMENT_DEMO_PORT` and `PAYMENT_DEMO_ORIGIN` in the server;
  `VITE_API_BASE_URL` and `PAYMENT_DEMO_PORT` must agree on the same port, and
  `PAYMENT_DEMO_ORIGIN` must match the page's origin.

Generated files under `sdk/` and generated model companions are generated output.
Edit the authored contract or handwritten source, then run `npm run generate`.

[Quick start](../docs/guide/quick-start.md) shows how to add the packages to an existing application.
