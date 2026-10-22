# Composing models

Nest models, derive types with `Pick` and `Omit`, and model unions that convert predictably.

## Nested models and derived types

A field typed with your class, such as `office: Place`, holds an instance of that class. A field typed with the declaration alias (`TPlace`) holds a plain object. `Pick`, `Omit`, `Partial`, `Required` and `Readonly` produce a derived type as a plain object.

<<< ../../examples/models/src/assignee.model.ts#nested-and-derived

A derived type keeps field conversion and validation, but not `Place` methods, constructor defaults or rules added with [`getValidator(model).extend()`](/guide/validation#instance-rules). `Readonly` keeps TypeScript's modifier and doesn't freeze the value.

A derived type is exact by default, like any model: extra keys fail validation; `{ exact: false }` keeps them. Put a whole-object [`TValidation`](/guide/tags#add-a-custom-field-rule) predicate or [`TSerde`](/guide/tags#convert-a-field-to-a-different-json-value) formatter on the derived type itself rather than reusing one written for another shape.

## Unions

Generation emits conversion for these unions and fails for anything else; conversion never tries branches one by one.

Supported:

- literal unions, such as `'paid' | 'pending'`
- optional and nullish values: `T | undefined`, `T | null`
- a scalar or several scalars beside one array or one tuple: `string | Date[]`, `string | [Date]`, `T | T[]`, as in query objects (`status?: Status | Status[]`); a scalar that converts, such as `Date` or a model, must be the only scalar
- object unions with one unique, required literal discriminator
- an SDK model class (generated from an OpenAPI document) plus a primitive or a uniquely tagged object

A discriminated union of two models:

<<< ../../examples/models/src/contact.model.ts#discriminated-union

Generation fails for:

- a root `IModel` union such as `IModel<TEmail | TPhone>` ([`RUNM1052`](/reference/diagnostics#runm1052)); put the union in a field
- object unions without a unique required literal discriminator ([`RUNM1080`](/reference/diagnostics#runm1080)); give each variant a required literal field such as `kind: 'cat'`
- several undiscriminated SDK model classes, or an SDK model class plus an array, `any`, `unknown`, intersection or untagged object ([`RUNM1030`](/reference/diagnostics#runm1030))
- any union that would need to probe alternatives (`Union has ambiguous conversions`)

`Extract` and `Exclude` keep your class only when the selected branch is the unchanged named model; a structurally identical plain object doesn't gain its methods.

## Strict objects and `any`

The second type argument of `IModel` controls extra properties, `any` and `unknown`:

<<< ../../examples/models/src/metadata.model.ts#exact-and-any

`exact` defaults to `true`: extra properties fail validation, including in nested plain objects. The own state of a model instance is not an extra property. Set `exact: false` in `golem.yaml` to change the default for every model; the model option overrides it. Constructors still assign declared fields only, and extra keys added to an instance aren't serialized.

A field typed `any` or `unknown` fails with [`RUNM1011`](/reference/diagnostics#runm1011) unless `allowAny` is `true` for the model or in `golem.yaml`. `allowAny: true` skips inferred structure and conversion for that field; explicit tags still run. `{ allowAny: false }` tightens a permissive global setting. Neither option changes which fields `toWireFormat` emits.
