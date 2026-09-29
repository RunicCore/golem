# Generated files

Know which generated paths and names you can import and commit, and which may change.

## Public paths

| Path | What it holds | Stable |
| --- | --- | --- |
| `sdk/index.js` | The client, its types, and the schema and validation helpers | Yes |
| `sdk/models/<Name>.js` | One runtime model class per object schema | Yes |
| `sdk/operations/<name>.js` | One operation factory per endpoint | Yes |
| `<name>.model.generated.ts` | The generated base beside each model file | Yes |
| `runic-codegen.yaml` | Your configuration keys | Yes |
| `.runic-codegen/outputs.json` | The list of files the generator owns | Yes |

The SDK folder is the `sdk` output you configure. Import only from the paths above.

## Default locations

| Output | Location |
| --- | --- |
| Model files | `src/generated/models/` |
| Operation codecs | `src/generated/operation-codecs.ts` |
| OpenAPI document and SDK | The paths you configure |

`models.output` overrides the model location. The operation codecs path is fixed.

## Internal SDK files

Every other file in an SDK is internal and may change in a minor release. Do not import them:

- `models/_group-*.ts`
- `types.ts`
- `schemas.ts`
- `input-schemas.ts`
- `output-schemas.ts`
- `validation-schemas/*`
- `client.ts`
- `iobject-plugin-keys.ts`
- `model-manifest.json`

The generator no longer writes `validation.ts`, `client-runtime.ts` or `models.ts`. Their code lives in `@exprtlabs/codegen`.

## Derived type names

A type built from a model, such as `Omit<TMerchant, 'id'>`, gets a schema name from its shape. Names are stable across runs.

| Type | Name |
| --- | --- |
| `Omit<TMerchant, 'id'>` | `MerchantOmitId` |
| `Pick<TMerchant, 'name' \| 'id'>` | `MerchantPickIdName` |
| `Partial<Omit<TMerchant, 'id'>>` | `MerchantOmitIdPartial` |
| `TMerchant & TMoney` | `MerchantAndMoney` |
| The `billing` property of `TPayment` | `PaymentBilling` |

The first matching rule gives the name:

1. An intersection of named models. The sorted names join with `And`.
2. A type alias that names the type, such as `type TBilling = Omit<TMerchant, 'id'>`, which gives `Billing`. A leading `T` is dropped from the alias name. The alias needs no type parameters, must be declared in your own source rather than a `.d.ts` file, and must have an ASCII identifier name.
3. A named model wrapped in up to three levels of `Pick`, `Omit`, `Partial`, `Required` and `Readonly`, each key list with at most three string-literal keys. Keys are sorted and written in PascalCase, innermost wrapper first.
4. Anything else: the owner plus the property, such as `TPayment.billing` giving `PaymentBilling`. The owner of a model field is the model. The owner of a controller parameter is the method name plus `Body` or `Query`, such as `CreatePaymentBody`, or the method name plus the parameter name for other parameters. The owner of a controller response is the method name plus `Response`.

When the members of a union fall back to the owner plus the property, each member adds a part. The part is the PascalCase value of a string-literal property that every member has with a different value, such as `OrderEitherCard`. Without such a property, the part is the member's position, such as `OrderEither1`. Members named by rules 1 to 3 keep those names.

Non-default settings add suffixes, in this order: `Loose` for `exact: false`, `Any` for `allowAny: true`, and `Wire` for the wire representation. Controller signatures use `exact: false`, so the same derived type there ends in `Loose`, such as `MerchantOmitIdLoose`.

Equal shapes from different expressions merge into one schema. The alphabetically first name stays.

Two different shapes that get the same name fail generation with [RUNM1059](/reference/diagnostics#runm1059), as does a derived name that equals a model name. The message names both source locations. Declare a named type alias to choose the name.

## Schema file names

Each SDK writes its validation schemas as `<Component>.<input|output>.ts`. Characters in the component name other than letters, digits, `_`, `$` and `-` become `_`, and the name is cut at 64 characters. When two names are equal ignoring case, both get a six-character hex suffix.

## Codec identity

The id of a codec is the model name plus eight hex characters. The hash covers the contract shape and how the codec builds values: its source (`typescript` or `openapi`) and whether it builds a plain object or a class. A hand-written model and an SDK model with the same name and shape have different ids. Import order does not decide which codec `parse` uses.

## Runtime version

Install `@exprtlabs/codegen` at or above the version of each generator package you use, with the same major version. `generate`, `check`, `exec` and `watch` compare the installed `@exprtlabs/codegen` with each installed generator package and fail before they write when the runtime is older or has a different major version. The message names both packages and versions. The SDK manifest records `runtime.minimumVersion` for reference.
