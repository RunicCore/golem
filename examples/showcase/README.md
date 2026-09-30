# Project access showcase

This complete project edits permissions as a number and serializes them as the
hexadecimal string required by the API.

- The OpenAPI SDK supplies the nested member type.
- The NestJS controller and backend model generate the OpenAPI contract.
- The handwritten editor supplies `canWrite()` and `grantWrite()`.
- Tags enforce field constraints and a read-permission rule.
- A serde pair converts `number` in the model to `0x...` on the wire.
- The normal command runs offline.

## Install and run from the download

Use Node.js 22.15 or newer:

```sh
npm install
npm run generate
npm start
```

The output includes:

```text
showcase: can write false
showcase: can write after grant true
showcase: wire ... permissions: '0x5'
showcase: permission error A project access record must include the read permission bit.
```

The optional HTTP adapter runs only when `PROJECT_ACCESS_API_BASE_URL` is set:

```sh
PROJECT_ACCESS_API_BASE_URL=https://api.example.com npm start
```

The project does not start an API server. Replace the URL with a matching
`PUT /projects/{projectId}/access` service.

## Source files

| File | Responsibility |
| --- | --- |
| `backend/project-access.model.ts` | Native backend model and tagged fields |
| `backend/project-access.controller.ts` | Route, request and response declaration |
| `api.yaml` | Generated OpenAPI shapes and update operation |
| `runic-codegen.yaml` | Controller, SDK and model generation jobs |
| `src/project-access.model.ts` | Handwritten editor and model declaration |
| `src/access-rules.ts` | Validation tags and conversion functions |
| `src/edit-access.ts` | Decode a wire draft, grant write access, re-encode it |
| `src/check-permissions.ts` | Validate a draft with the read-permission bit missing |
| `src/home-demo.ts` | Runs `edit-access.ts`, then validates a copy missing the read-permission bit |
| `src/save-access.ts` | Serialized request passed to `.execute` |
| `src/http.ts` | Calls `save-access.ts` against a configured base URL |
| `src/main.ts` | Offline run and optional HTTP call |
| `src/app.test.ts` | Tests for the offline demo and the request boundary |

The project archive contains the full source for every file, including the
generated SDK and model companions.

Edit authored files and run `npm run generate` again. Generated output under
`sdk/`, `api.yaml` and model companions is replaced.

## Request boundary

The adapter keeps the call explicit:

```ts
import { toWireFormat } from '@exprtlabs/golem/serde';
import type { ProjectAccessClientPort } from '../sdk/index.js';
import type { ProjectAccessEditor, TProjectAccessEditor } from './project-access.model.js';
import type { ProjectAccessEditorJSON } from './project-access.model.generated.js';

export async function saveProjectAccess(
  client: ProjectAccessClientPort,
  projectId: string,
  access: ProjectAccessEditor,
) {
  const updateAccess = client.updateProjectAccess();
  const body: ProjectAccessEditorJSON = toWireFormat<TProjectAccessEditor>(access);
  return updateAccess.execute({ path: { projectId }, body });
}
```

`toWireFormat` is synchronous, and the generated operation sends the returned
wire object to the configured API. Those generic serde calls require TypeScript
7, `ttsc`, and `@exprtlabs/golem/ttsc-plugin`.
