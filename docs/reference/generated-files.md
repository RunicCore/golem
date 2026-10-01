# Generated files

Know which generated paths and names you can import and commit, and which may change.

## Public paths

| Path | What it holds | Stable |
| --- | --- | --- |
| `sdk/index.js` | The client and its types | Yes |
| `sdk/models/<Name>.js` | One runtime model class per object schema | Yes |
| `sdk/operations/<name>.js` | One operation factory per endpoint | Yes |
| `<name>.model.generated.ts` | The generated base beside each model file | Yes |
| `golem.yaml` | Your configuration keys | Yes |
| `.golem/outputs.json` | The list of files the generator owns | Yes |

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
- `schemas.ts`, written only for an `ajvStandalone` job
- `input-schemas.ts`
- `output-schemas.ts`
- `validation-schemas/*`
- `client.ts`
- `iobject-plugin-keys.ts`
- `model-manifest.json`

The generator no longer writes `validation.ts`, `client-runtime.ts` or `models.ts`. Their code lives in `@exprtlabs/golem`.

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
2. A type alias that names the type, such as `type TBilling = Omit<TMerchant, 'id'>`, which gives `Billing`. A leading `T` is dropped from the alias name only before an uppercase letter. The alias needs no type parameters, must be declared in your own source rather than a `.d.ts` file, and must have an ASCII identifier name.
3. A named model wrapped in up to three levels of `Pick`, `Omit`, `Partial`, `Required` and `Readonly`, each key list with at most three string-literal keys. Keys are sorted and written in PascalCase, innermost wrapper first.
4. Anything else: the owner plus the property, such as `TPayment.billing` giving `PaymentBilling`. The owner of a model field is the model. The owner of a controller parameter is the controller class name without a trailing `Controller`, the method name, and `Body` or `Query`, such as `PaymentsCreateBody` for `PaymentsController.create`. Other parameters use the parameter name instead. The owner of a controller response ends in `Response`. Underscores and other characters outside letters and digits are dropped and the next letter is capitalized, so `Order_V2` becomes `OrderV2`. A property name that contains a non-ASCII character gives the part `Field`, such as `OrderField`. An owner name that contains a non-ASCII character, or does not start with a letter after cleanup, becomes `Model`, such as `ModelShape`.

When the members of a union fall back to the owner plus the property, each member adds a part. The part is the discriminant value: the PascalCase value of a string-literal property that every member has, with values that stay different. If several properties qualify, the first in code-unit order wins, such as `OrderEitherCard`. Otherwise the part is the member's position in the union as written, such as `OrderEither1`. A union written through a type alias counts the alias's members in place. Members named by rules 1 to 3 keep those names.

Non-default settings add suffixes, in this order: `Loose` for `exact: false`, `Any` for `allowAny: true`, and `Wire` for the wire representation. Controller signatures use `exact: false`, so their names end in `Loose`, such as `PaymentsCreateBodyMerchantLoose` for the `merchant` field of an inline body.

Equal shapes from different expressions merge into one schema. The alphabetically first name stays.

Two different shapes that get the same name fail generation with [RUNM1059](/reference/diagnostics#runm1059), as does a derived name that equals a model name. The message names both source locations. Declare a named type alias to choose the name.

## Schema file names

Each SDK writes its validation schemas as `<Component>.<input|output>.ts`. Characters in the component name other than letters, digits, `_`, `$` and `-` become `_`, and the name is cut at 64 characters. When two names are equal ignoring case, both get a six-character hex suffix.

## Codec identity

The id of a codec is the model name plus eight hex characters. The hash covers the contract shape and how the codec builds values: its source (`typescript` or `openapi`) and whether it builds a plain object or a class. A hand-written model and an SDK model with the same name and shape have different ids. Import order does not decide which codec `parse` uses.

## Runtime version

Install `@exprtlabs/golem` at or above the version of each generator package the configuration uses, with the same major version. `generate`, `check`, `exec` and `watch` compare the installed `@exprtlabs/golem` with each of those generator packages and fail before they write when the runtime is older or has a different major version. The message names both packages and versions. The SDK manifest records `runtime.minimumVersion` for reference.
