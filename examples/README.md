# Golem examples

Three complete TypeScript projects, each with its source contract, configuration
and a runnable entrypoint. None commits its generated files. Browse them in the
[Golem repository](https://github.com/RunicCore/golem). The documentation pages
explain the examples and show source regions from these maintained files.

| Example | Shows |
| --- | --- |
| [models](models/) | An offline task tracker: models, tags, validation, serialization, field types and dates. Start here to define models without a server. |
| [shared-folder](shared-folder/) | A shared folder that declares a model, used by two apps, one through a plain include and one through a folder link. Each app generates the model in its own output. The web app extends it and validates; the worker does not. |
| [payments](payments/) | A merchant payments app: NestJS controllers that produce an OpenAPI document, a typed client, a React and MobX editor, and a client for a third-party provider with auth, streams, codecs and dates. |

The guides walk through them: [Define models](../docs/guide/models.md),
[Share models between apps](../docs/guide/shared-models.md),
[Validation tags](../docs/guide/tags.md),
[OpenAPI from controllers](../docs/guide/nestjs.md),
[Generate a client](../docs/guide/client.md),
[SDK types in your models](../docs/guide/models-and-client.md) and
[MobX and React](../docs/guide/mobx.md).

## Install and run

Every example depends on `1.1.0-rc.0` of `@exprtlabs/golem*`. Run them from this repository checkout: run `npm install` once at
the repository root, then in the example directory:

```sh
npm run generate   # write the generated files, for your editor
npm test           # offline; golem build generates first
```

- `models`: `npm start` prints a walkthrough, one line per feature. It needs no
  server, browser or network.
- `shared-folder`: `npm test` builds both apps and runs their tests.
- `payments`: `npm run demo` starts the API and a stand-in provider on free
  ports and submits one payment. `npm run dev` starts the API on port 3000, the
  provider on 3001 and the editor at `http://127.0.0.1:5173`. `API_PORT` sets
  the API port.

Files under `sdk/`, the `*.model.generated.ts` files, `src/generated/` and `.golem/` are generated output, and each example's `.gitignore` lists them.
Edit the authored contract or handwritten source, then run `npm run generate`.
The [Install](../docs/guide/install.md) page lists the packages and profiles.

[Quick start](../docs/guide/quick-start.md) shows how to add the packages to an existing application.
