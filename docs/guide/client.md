# Generate a client

Point `@exprtlabs/openapi-to-ts` at an OpenAPI document and call its operations with typed, validated requests and responses.

<<< ../../examples/openapi/src/list-tasks.ts#create-and-list

Set `baseUrl` to your service — the client doesn't pick an OpenAPI `servers` URL — then `client.listTasks()` creates a reusable operation and `.execute({})` sends `GET /tasks` and returns the response.

## Install

```sh
npm install @exprtlabs/codegen@rc ajv ajv-formats
npm install --save-dev @exprtlabs/openapi-to-ts@rc typescript@~7.0.2 ttsc@~0.30.4
```

Requests and responses are validated by default; `ajv` and `ajv-formats` supply the validators. Add the ttsc plugin to `tsconfig.json` and compile with `npx ttsc` ([TypeScript setup](/guide/install#typescript-setup)). Include the generated `sdk/` directory in the TypeScript program that builds your app. For precompiled validators, set [`ajvStandalone`](/reference/config#validation-profiles).

## Point to your OpenAPI document

Add `runic-codegen.yaml` at the project root. Paths are relative to it, and `name: Tasks` names the client `TasksClient`.

<<< ../../examples/openapi/runic-codegen.yaml

The document is the contract. Keep it in the project or point `input` at the file your API already owns; any [supported OpenAPI feature](/reference/openapi-support) works:

<<< ../../examples/openapi/api.yaml

Generation fails on an invalid document.

## Generate the SDK

```sh
npx runic-codegen generate
```

The command writes `sdk/`. Import `TasksClient` from `../sdk/index.js`.

## Generated files

Import only the public [generated files](/reference/generated-files); the others may change in a minor release.

| File | Contents | Public |
| --- | --- | --- |
| `index.ts` | Entrypoint | Yes |
| `client.ts` | The client class | No |
| `operations/<name>.ts` | One operation factory per endpoint | Yes |
| `models/<Schema>.ts` | A runtime model class per object schema | Yes |
| `model-manifest.json` | Read by the model generator | No |

For a schema named `Task` you get `Task`, the JSON data type, and `TaskModel`, its runtime class. Use `TaskModel` when you want an instance rather than response data:

<<< ../../examples/openapi/src/task-model.ts#task-model

Build your own model around SDK types the same way in [Models with a client](/guide/models-and-client).

Change `api.yaml` and generate again when the contract changes. Keep your own code, including your model classes, outside `sdk/`.

## Call the generated client

Pass query parameters and a request body:

<<< ../../examples/openapi/src/task-requests.ts#request-arguments

Check the declared status before reading the body:

<<< ../../examples/openapi/src/read-task.ts#read-task

Full example: [`examples/openapi`](https://github.com/exprtlabs/codegen/tree/main/examples/openapi)
