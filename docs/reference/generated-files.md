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

## Files you don't commit

| Path | What it holds |
| --- | --- |
| `.golem/rewrites.json` | Where each generic serde call sits in your sources. `golem generate`, `golem watch` and `golem build` write it; the Vite and esbuild plugins and the Node loader read it ([TypeScript setup](/guide/install#typescript-setup)). |
| `.golem/build/` | The incremental state and the staged copy of your sources that `golem build` keeps per tsconfig. |

Add both to `.gitignore`. Run `golem generate` in CI before a bundler build, which creates the index.

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
- `input-schemas.ts`
- `output-schemas.ts`
- `validation-schemas/*`
- `client.ts`
- `inbound.ts` and `links.ts` (their names are public through `sdk/index.js`)
- `model-manifest.json`
- `operations/<name>.validators.generated.*` and `models/*.validators.generated.*` (with `ajvStandalone: true`)

## Internal model files

In the model output (`src/generated/models/` by default), every file is internal: `models.generated.ts`, `models.validators.generated.js` and `.d.ts` with `ajvStandalone: true`, and `models.generated.NOTICES.txt`. Each `<name>.model.generated.ts` is public for the models its source declares: `<Alias>BaseModel` for an `IModel`, the `<Alias>Fields`, `<Alias>JSON` and `<Alias>Init` types, and `parse<Alias>`, `stringify<Alias>`, `validate<Alias>`, `assert<Alias>`, `toWireFormat<Alias>` and `fromWireFormat<Alias>` functions. `<Alias>` is the exact type alias: `type TPayment = IModel<…>` gives `TPaymentBaseModel` and `parseTPayment`, `type Payment = IModel<…>` gives `PaymentBaseModel`, and `type TPermissionModel = IModel<…>` gives `TPermissionModelBaseModel`. A class links to its model through `extends <Alias>BaseModel` and can have any name; a file can't export two classes that extend the same generated class directly. Codecs of [derived types](#derived-type-names) and exports that start with `__golem` are internal.

The models job also writes `.golem/codec-keys.json` beside `.golem/outputs.json`. It maps each model and class to its codec id for `golem build`, the loader and the bundler plugins. An SDK holds its ids in `model-manifest.json`. Commit or ignore `.golem/codec-keys.json` with the generated files.

The generator no longer writes `validation.ts`, `client-runtime.ts` or `models.ts`. Their code lives in `@exprtlabs/golem`.

## Derived type names

A type built from a model, such as `Omit<TMerchant, 'id'>`, gets a schema name from its shape. Names are stable across runs.

| Type | Name |
| --- | --- |
| `Omit<TMerchant, 'id'>` | `TMerchantOmitId` |
| `Pick<TMerchant, 'name' \| 'id'>` | `TMerchantPickIdName` |
| `Partial<Omit<TMerchant, 'id'>>` | `TMerchantOmitIdPartial` |
| `TMerchant & TMoney` | `TMerchantAndTMoney` |
| The `billing` property of `TPayment` | `TPaymentBilling` |

The first matching rule gives the name:

1. An intersection of named models. The sorted names join with `And`.
2. A type alias that names the type, such as `type TBilling = Omit<TMerchant, 'id'>`, which gives `TBilling`. The alias name is used as written. The alias needs no type parameters, must be declared in your own source rather than a `.d.ts` file, and must have an ASCII identifier name.
3. A named model wrapped in up to three levels of `Pick`, `Omit`, `Partial`, `Required` and `Readonly`, each key list with at most three string-literal keys. Keys are sorted and written in PascalCase, innermost wrapper first.
4. Anything else: the owner plus the property, such as `TPayment.billing` giving `TPaymentBilling`. The owner of a model field is the model. The owner of a controller parameter is the controller class name without a trailing `Controller`, the method name, and `Body` or `Query`, such as `PaymentsCreateBody` for `PaymentsController.create`. Other parameters use the parameter name instead. The owner of a controller response ends in `Response`. Underscores and other characters outside letters and digits are dropped and the next letter is capitalized, so `Order_V2` becomes `OrderV2`. A property name that contains a non-ASCII character gives the part `Field`, such as `OrderField`. An owner name that contains a non-ASCII character, or does not start with a letter after cleanup, becomes `Model`, such as `ModelShape`.

When the members of a union fall back to the owner plus the property, each member adds a part. The part is the discriminant value: the PascalCase value of a string-literal property that every member has, with values that stay different. If several properties qualify, the first in code-unit order wins, such as `TOrderEitherCard`. Otherwise the part is the member's position in the union as written, such as `TOrderEither1`. A union written through a type alias counts the alias's members in place. Members named by rules 1 to 3 keep those names.

Non-default settings add suffixes, in this order: `Loose` for `exact: false`, `Any` for `allowAny: true`, and `Wire` for the wire representation. Controller signatures use `exact: false`, so their names end in `Loose`, such as `PaymentsCreateBodyMerchantLoose` for the `merchant` field of an inline body.

Equal shapes from different expressions merge into one schema. The alphabetically first name stays.

Two different shapes that get the same name fail generation with [RUNM1059](/reference/diagnostics#runm1059), as does a derived name that equals a model name. The message names both source locations. Declare a named type alias to choose the name.

## Schema file names

Each SDK writes its validation schemas as `<Component>.<input|output>.ts`. Characters in the component name other than letters, digits, `_`, `$` and `-` become `_`, and the name is cut at 64 characters. When two names are equal ignoring case, both get a six-character hex suffix.

## Codec identity

The id of a codec is the model name plus eight hex characters. The hash covers the contract shape and how the codec builds values: its source (`typescript` or `openapi`) and whether it builds a plain object or a class. A hand-written model and an SDK model with the same name and shape have different ids. Import order does not decide which codec `parse` uses.

A model that both the model job and an SDK generate has two independent codecs: the functions in `<name>.model.generated.ts` return your class or its plain fields, and the SDK's functions return the SDK's values.

## Runtime version

Install `@exprtlabs/golem` at or above the version of each generator package the configuration uses, with the same major version. `generate`, `check`, `exec` and `watch` compare the installed `@exprtlabs/golem` with each of those generator packages and fail before they write when the runtime is older or has a different major version. The message names both packages and versions. The SDK manifest records `runtime.minimumVersion` for reference.
