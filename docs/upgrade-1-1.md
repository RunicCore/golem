# Upgrade to 1.1

Check your TypeScript version, then move to Golem 1.1 or stay on 1.0.

## Golem 1.1 is a breaking release

Golem 1.1 keeps a 1.x number and drops TypeScript 7.0. A range such as `^1.0.0` or `1.x` in your `package.json` stays inside 1.x, so an update can take you to 1.1. When your project uses TypeScript 7.0, pin Golem to 1.0 until you move to TypeScript 7.1 or 6.

| TypeScript | Golem 1.1 | Action |
| --- | --- | --- |
| 6.0 and newer 6.x | supported | none |
| 7.0 | fails at load | install TypeScript 7.1 or 6, or stay on Golem 1.0 |
| 7.1.0-beta and newer | supported | none |

Run `npm ls typescript` to read the version that your project resolves.

## Pass the exact id to the codec registry {#codec-ids}

`getObjectCodec`, `getIModelClass`, `requireObjectCodec`, `requireIModelClass` and `registerIModelClass` from `@exprtlabs/golem/serde` match the id exactly. In 1.0 a short model name such as `TOrder` also found the codec `TOrder_<8 hex digits>`. In 1.1 it finds nothing. Generated files and the build rewrite already pass the exact id, so only your own calls change.

Get the exact id from one of these:

- `findCodecIdForConstructor(Order)` for a class that is registered.
- The `.golem/codec-keys.json` file in the directory of `golem.yaml`, which maps each `<file>#<name>` to its id.
- The `codecId` of a model in the `model-manifest.json` of an SDK.

## Expect an empty description on a default response {#empty-response-description}

A controller route with no `@ApiResponse` or named response decorator gets `description: ""` on its default response, as `@nestjs/swagger` writes it. In 1.0 the description was `Success`, or `Created`, `Accepted` or `No Content` for status 201, 202 or 204. `@ApiNoContentResponse()` with no description also gets `""`; in 1.0 it got `No Content`. Run `npx golem generate`, then update any test or tool that reads or compares that description. Add `description` to `@ApiOkResponse` or another response decorator to keep a text.

## Update `$ref`s to renamed model classes {#api-schema-names}

A model class with `@ApiSchema({ name: 'PlacedOrder' })` is now the component `PlacedOrder` in the OpenAPI document of the `controllers` job. In 1.0 the document used the class name and ignored `@ApiSchema`. The generated models keep the model's name.

- Update the `$ref`s and the generated-client code that use the class name of such a model.
- Remove `@ApiSchema` from the model class when you want to keep the class name.

## Read local paths relative to the working directory {#message-paths}

Golem commands and generators now print a local file relative to the working directory. This is the form that `tsc` uses. In 1.0, many messages printed the absolute path.

```text
The TypeScript configuration packages/app/tsconfig.json has errors:
```

A path in a message that does not lie below the working directory starts with `..`. The working directory itself prints as `.`. A URL and a path that is already relative stay as they are. Paths that golem writes into generated files and JSON files do not change.

When a script or an editor task parses golem messages, change it to read this form. Run the command from the folder where you want the paths to start.

## Expect a class for a union with a shared variant {#union-model-classes}

Only a union that shares a variant with another union changes form. A union with no shared variant generates the same files as in 1.0.

In 1.0, a variant that two unions selected stopped both union classes, and the generator wrote the warning `OPENAPI_UNION_SHARED_VARIANT`. In 1.1 each of those unions gets its model class:

- The shared variant extends its own base schema, not a union class.
- Each union that selects the shared variant answers `value instanceof PetModel` with true for it. TypeScript narrows `value` to the variants.
- The other variants of such a union now extend its class. In 1.0 they extended the base schema.
- A subclass that you write for a union class tests its own prototype chain, not the variants of the union.

Remove any code that depends on the warning. Run `npx golem generate` after you update.

## Move to TypeScript 7.1 or 6

Install one of the supported versions, then update the Golem packages:

```sh
npm install --save-dev typescript@~7.1.0-beta
# or: npm install --save-dev typescript@^6.0.0
npm install @exprtlabs/golem@^1.1.0
```

Update the other Golem packages that your project lists in the same way. The `typescript` peer range of `@exprtlabs/golem`, `@exprtlabs/golem-model` and `@exprtlabs/golem-ts-openapi` is `>=6.0.0 <7 || >=7.1.0-0 <8` ([Install](/guide/install#peer-dependencies)). Run `npx golem generate` afterwards. Generation writes the same files on TypeScript 6.0+ and 7.1+.

## Stay on Golem 1.0 with TypeScript 7.0

Pin each Golem package to 1.0.x, so that no update installs 1.1:

```sh
npm install @exprtlabs/golem@~1.0.0
```

Pin `@exprtlabs/golem-model`, `@exprtlabs/golem-openapi` and `@exprtlabs/golem-ts-openapi` the same way when you use them. Golem 1.0 supports TypeScript 6.0+ and 7.0.

## Read the load error

Golem 1.1 on TypeScript 7.0 stops at load with this message:

```text
golem supports TypeScript 6.0+ and 7.1+; found <version> at <path>. golem 1.0 supports TypeScript 7.0.
```

Do one of the two actions above: install TypeScript 7.1 or 6, or pin Golem to 1.0. The [compatibility](/compatibility#ts) page lists the other load errors.
