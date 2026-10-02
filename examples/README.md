# Golem examples

Two complete TypeScript projects, each with its source contract, configuration,
generated files and a runnable entrypoint. Browse them in the
[Golem repository](https://github.com/RunicCore/golem). The documentation pages
explain the examples and show source regions from these maintained files.

| Example | Shows |
| --- | --- |
| [models](models/) | An offline task tracker: models, tags, validation, serialization, composition and dates. Start here to define models without a server. |
| [payments](payments/) | A merchant payments app: NestJS controllers that produce an OpenAPI document, a typed client, a React and MobX editor, and a client for a third-party provider with auth, streams, codecs and dates. |

The guides walk through them: [models](../docs/guide/models.md),
[type tags](../docs/guide/tags.md),
[NestJS](../docs/guide/nestjs.md),
[an API client](../docs/guide/client.md),
[models with a client](../docs/guide/models-and-client.md) and
[MobX and React](../docs/guide/mobx.md).

## Install and run

Both examples depend on `1.0.0-rc` of `@exprtlabs/golem*`, which is not
published yet. Run them from this repository checkout: run `npm install` once at
the repository root, then in the example directory:

```sh
npm run generate   # write the generated files
npm test           # offline
```

- `models`: `npm start` prints a walkthrough, one line per feature. It needs no
  server, browser or network.
- `payments`: `npm run demo` starts the API and a stand-in provider on free
  ports and submits one payment. `npm run dev` starts the API on port 3000, the
  provider on 3001 and the editor at `http://127.0.0.1:5173`. `API_PORT` sets
  the API port.

Files under `sdk/` and the `*.model.generated.ts` files are generated output.
Edit the authored contract or handwritten source, then run `npm run generate`.
See [Installation](../docs/guide/install.md) for the `@rc` tag and profiles.

[Quick start](../docs/guide/quick-start.md) shows how to add the packages to an existing application.
