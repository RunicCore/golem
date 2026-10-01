# Example: permissions end to end

Follow one permissions contract through a NestJS API, an OpenAPI SDK and an application model.

The API sends permission bits as a hexadecimal string; your model works with a number.

## Define the field rules

<<< ../../examples/showcase/src/access-rules.ts#model-and-tags

## Generate the API contract

The backend declares the same contract, and one configuration generates the document and the SDK without starting a server:

<<< ../../examples/showcase/backend/project-access.model.ts#backend-model

<<< ../../examples/showcase/backend/project-access.controller.ts#project-access-controller

<<< ../../examples/showcase/golem.yaml

## Define the model

The SDK type carries only the JSON schema, so re-attach `PermissionBits` to get the number field and the read-bit rule.

<<< ../../examples/showcase/src/project-access.model.ts#model-definition

## Load, edit and serialize

<<< ../../examples/showcase/src/edit-access.ts#home-example

## Show an invalid edit

<<< ../../examples/showcase/src/check-permissions.ts#permission-errors

The check returns: "A project access record must include the read permission bit."

## Save through the client

<<< ../../examples/showcase/src/save-access.ts#api-operations

The class as type argument (`ProjectAccessEditor`) builds your class; the `T…` type (`TProjectAccessEditor`) gives or takes a plain object, here typed as [`ProjectAccessEditorJSON`](/guide/models#declare-fields).

Run `npm start` in `examples/showcase`; set `PROJECT_ACCESS_API_BASE_URL` to send the save to a real API.

Full example: [`examples/showcase`](https://github.com/RunicCore/golem/tree/master/examples/showcase)
