# Composing models

Nest models, derive types with `Pick` and `Omit`, and model unions that convert predictably.

## Nested models and derived types

A field typed with your class, such as `home: Address`, holds an instance of that class. A field typed with the declaration alias (`TAddress`) holds a plain object. `Pick`, `Omit`, `Partial`, `Required` and `Readonly` produce a derived type as a plain object.

```ts
import type { IModel } from '@exprtlabs/golem/model';
import { parse } from '@exprtlabs/golem/serde';
import { AddressBase, CustomerBase } from './customer.model.generated.js';

export type TAddress = IModel<{
  id: string;
  city: string;
  country: string;
}>;
export class Address extends AddressBase {}

export type TCustomer = IModel<{
  home: Address;
  shipping: Omit<TAddress, 'id'>;
  draft: Partial<Pick<TAddress, 'city' | 'country'>>;
}>;
export class Customer extends CustomerBase {}

const customer = parse<Customer>(JSON.stringify({
  home: { id: 'address-1', city: 'Hanoi', country: 'VN' },
  shipping: { city: 'Da Nang', country: 'VN' },
  draft: { city: 'Hue' },
}));
console.log(customer.home instanceof Address); // true
console.log(Object.getPrototypeOf(customer.shipping) === Object.prototype); // true
```

A derived type keeps field conversion and validation, but not `Address` methods, constructor defaults or rules added with [`getValidator(model).extend()`](/guide/validation#instance-rules). `Readonly` keeps TypeScript's modifier and doesn't freeze the value.

A derived type is exact by default, like any model: extra keys fail validation; `{ exact: false }` keeps them. Put a whole-object [`TValidation`](/guide/tags#add-a-custom-field-rule) predicate or [`TSerde`](/guide/tags#convert-a-field-to-a-different-json-value) formatter on the derived type itself rather than reusing one written for another shape.

## Unions

Generation emits conversion for these unions and fails for anything else; conversion never tries branches one by one.

Supported:

- literal unions, such as `'paid' | 'pending'`
- optional and nullish values: `T | undefined`, `T | null`
- a scalar or an array of it: `T | T[]`, as in query objects (`status?: Status | Status[]`)
- object unions with one unique, required literal discriminator
- an SDK model class (generated from an OpenAPI document) plus a primitive or a uniquely tagged object

A discriminated union of two models:

```ts
import type { IModel } from '@exprtlabs/golem/model';
import { EmailBase, PhoneBase } from './contact.model.generated.js';

export type TEmail = IModel<{ kind: 'email'; address: string }>;
export class Email extends EmailBase {}
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
export class Phone extends PhoneBase {}
export type TContact = IModel<{ value: TEmail | TPhone }>;
```

Generation fails for:

- a root `IModel` union such as `IModel<TEmail | TPhone>` ([`RUNM1052`](/reference/diagnostics#runm1052)); put the union in a field
- object unions without a unique required literal discriminator (`Object union conversions require a unique, required literal discriminator`)
- several undiscriminated SDK model classes, or an SDK model class plus an array, `any`, `unknown`, intersection or untagged object ([`RUNM1030`](/reference/diagnostics#runm1030))
- any union that would need to probe alternatives (`Union has ambiguous conversions`)

`Extract` and `Exclude` keep your class only when the selected branch is the unchanged named model; a structurally identical plain object doesn't gain its methods.

## Strict objects and `any`

The second type argument of `IModel` controls extra properties and `any`:

```ts
import type { IModel } from '@exprtlabs/golem/model';

export type TOpen = IModel<{ name: string }, { exact: false }>;
export type TExact = IModel<{ name: string }>;
export type TExternal = IModel<{ payload: any }, { allowAny: true }>;
```

`exact` defaults to `true`: extra properties fail validation, including in nested plain objects. Constructors still assign declared fields only, and extra keys added to an instance aren't serialized.

`allowAny: true` skips inferred structure and conversion for that field; explicit tags still run. `{ allowAny: false }` tightens a permissive global setting. Neither option changes which fields `toWireFormat` emits.
