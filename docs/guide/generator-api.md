# Run the generators from code

Call a Golem generator from your own tool, then write the files it returns.

A generator returns files. It does not write them. The [CLI](/reference/cli) calls the same generators and writes the files for you. Call one yourself when you build your own tool.

Each generator module exports `apiVersion` and `generate(context)`:

- The context holds absolute paths and a `profile`.
- The result lists the `artifacts` (a path and the file content), the `manifestPaths` and the `watchInputs` of the run.
- The `generate` call of each module takes its own context type.

| Module | `generate` | Returns |
| --- | --- | --- |
| `@exprtlabs/golem-ts-openapi/generator` | Asynchronous | The OpenAPI document of your controllers |
| `@exprtlabs/golem-openapi/generator` | Asynchronous | The SDK files of an OpenAPI document |
| `@exprtlabs/golem-model/generator` | Synchronous | The generated files of your models |

Signatures and context fields are in the [Generator and tool API](/reference/generator-api).

## Generate OpenAPI from controllers

The first artifact is the OpenAPI document. A second artifact is a generated file that the rewrite reads. `manifestPaths` is empty.

```ts
import { generate } from '@exprtlabs/golem-ts-openapi/generator';

const result = await generate({
  root: '/absolute/app/backend',
  output: '/absolute/app/api/payments.yaml',
  info: { title: 'Payments API', version: '1' },
  profile: { mobx: false, validation: true },
});

console.log(result.artifacts[0]?.path); // /absolute/app/api/payments.yaml
```

Set `root`, `output`, `info` and `profile`. The other fields of [`ControllerContext`](/reference/generator-api#controllercontext) have defaults.

## Generate an OpenAPI SDK

`generate()` returns an `OpenApiGenerationResult`:

```ts
import { apiVersion, generate } from '@exprtlabs/golem-openapi/generator';

const result = await generate({
  input: '/absolute/app/api.yaml',
  output: '/absolute/app/sdk',
  name: 'Payments',
  profile: { mobx: false, validation: true },
});

console.log(apiVersion, result.artifacts.map(artifact => artifact.path));
```

Set `input`, `output` and `profile`. The other fields, such as `name` and the options for remote references, are in [`OpenApiContext`](/reference/generator-api#openapicontext).

The result's `manifestPaths` holds the SDK's `model-manifest.json`. Pass it in `manifestInputs` to the model generator, so your models can use the SDK models.

### Start from a loaded document

To generate from a document you already loaded, call `writeSdk`:

```ts
import { loadValidatedDocument, writeSdk } from '@exprtlabs/golem-openapi/generator';

const document = await loadValidatedDocument('/absolute/app/api.yaml');
const result = writeSdk(document, {
  output: '/absolute/app/sdk',
  profile: { mobx: false, validation: true },
});
```

`loadValidatedDocument` reads and checks the document and bundles its references. `writeSdk` reads no files and returns empty `watchInputs`. Its [signature](/reference/generator-api#writesdk) is in the reference.

## Generate TypeScript models

```ts
import { apiVersion, generate } from '@exprtlabs/golem-model/generator';

const result = generate({
  root: '/absolute/app',
  profile: { mobx: false, validation: true },
});

console.log(apiVersion, result.artifacts.length);
```

Set `root` and `profile`. The other fields, such as `suffixes` and `manifestInputs`, are in [`ModelContext`](/reference/generator-api#modelcontext).

## Check the result

1. Show each returned diagnostic to the user. Their codes are in [Diagnostics](/reference/diagnostics).
2. Treat an exception and a result that carries an `Error` diagnostic as a failed run.
3. Write the `artifacts` only after a run that did not fail.

## Skip work that did not change

Pass `onInput` to learn which files a run read. Watch the returned `watchInputs` and run the generator again when one changes. The rules for `onInput` and `session` are in the [host rules](/reference/generator-api#host-rules).

## Apply the results

A result is an in-memory plan. A tool that applies it does these steps:

- Keep the artifact paths and contents.
- Track `manifestPaths` and `watchInputs`.
- Choose a write policy, a stale-file policy and a record of the files it wrote.

The `golem` CLI applies the results for normal projects, in the [job order](/reference/config) of the configuration.
