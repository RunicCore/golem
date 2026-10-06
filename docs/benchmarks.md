# Serialization benchmarks

Compare how fast Golem's generated code parses, stringifies and validates next to libraries that do the same job.

::: warning
Benchmarks are for reference purposes only.
:::

<BenchmarkChart>
<template #plain>

Each library turns JSON into plain objects, checks every rule and rejects unknown properties. Golem uses an [`IObject` declaration](/guide/models#iobject-or-imodel) and also converts dates and [`TSerde` fields](/guide/tags#convert-a-field-to-a-different-json-value); Typia checks shapes only, so it can't run the Checkout payload.

</template>
<template #classes>

Each library turns JSON into instances of your classes and back, without validation. Golem generates the class you extend from an [`IModel` declaration](/guide/models#iobject-or-imodel); class-transformer uses decorators on classes you write.

</template>
<template #validated-classes>

Class instances are checked against their rules on the way in and out. Golem runs its own generated [validators](/reference/config#validation-profiles); class-validator runs decorator rules after class-transformer builds the instance, and doesn't reject unknown properties.

</template>
<template #plain-simple-code>

#### Declarations for the Simple object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.object.model.ts#simple [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.models.ts#simple [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#simple [Zod]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.ts#calls [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#calls [Zod]

:::

</template>
<template #plain-nested-code>

#### Declarations for the Nested object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.object.model.ts#nested [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.models.ts#nested [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#nested [Zod]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.ts#calls [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#calls [Zod]

:::

</template>
<template #plain-array-code>

#### Declarations for the Large array payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.object.model.ts#array [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.models.ts#array [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#array [Zod]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.ts#calls [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#calls [Zod]

:::

</template>
<template #plain-checkout-code>

#### Declarations for the Checkout payload

::: code-group

<<< @/../scripts/benchmark/fixtures/features/features.iobject.model.ts#checkout [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#checkout [Zod]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#calls [Zod]

:::

</template>
<template #classes-simple-code>

#### Declarations for the Simple object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.model.ts#simple [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-transformer.models.ts#simple [class-transformer]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-transformer.ts#calls [class-transformer]

:::

</template>
<template #classes-nested-code>

#### Declarations for the Nested object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.constrained.model.ts#nested [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-transformer.models.ts#nested [class-transformer]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-transformer.ts#calls [class-transformer]

:::

</template>
<template #classes-array-code>

#### Declarations for the Large array payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.model.ts#array [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-transformer.models.ts#array [class-transformer]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-transformer.ts#calls [class-transformer]

:::

</template>
<template #classes-checkout-code>

#### Declarations for the Checkout payload

::: code-group

<<< @/../scripts/benchmark/fixtures/features/features.model.ts#checkout [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/features/features-class-transformer.models.ts#checkout [class-transformer]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem.ts#calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/features/comparison-features-class-transformer.ts#calls [class-transformer]

:::

</template>
<template #validated-classes-simple-code>

#### Declarations for the Simple object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.model.ts#simple [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-validator.models.ts#simple [class-transformer + class-validator]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-validator.ts#calls [class-transformer + class-validator]

:::

</template>
<template #validated-classes-nested-code>

#### Declarations for the Nested object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.constrained.model.ts#nested [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-validator.models.ts#nested [class-transformer + class-validator]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-validator.ts#calls [class-transformer + class-validator]

:::

</template>
<template #validated-classes-array-code>

#### Declarations for the Large array payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.model.ts#array [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-validator.models.ts#array [class-transformer + class-validator]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/upstream/class-validator.ts#calls [class-transformer + class-validator]

:::

</template>
<template #validated-classes-checkout-code>

#### Declarations for the Checkout payload

::: code-group

<<< @/../scripts/benchmark/fixtures/features/features.model.ts#checkout [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/features/features-class-validator.models.ts#checkout [class-transformer + class-validator]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem.ts#calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/features/comparison-features-class-validator.ts#calls [class-transformer + class-validator]

:::

</template>
</BenchmarkChart>

## What is measured

Every library gets the same JSON payload. Before timing, each library must turn its parsed value back into the original JSON, and the libraries that validate must reject invalid variants of it. Those checks run in a separate process, so every library is timed on valid input only. A validator runs slower after it has rejected differently shaped input: V8 re-optimises a validator's generated function for the new object shapes. typia shows the same effect. Each library is timed in its own process, in two rounds with the library order reversed in the second. Each case is warmed up, then timed in six short batches; the table shows the median. A library that can't do a case says why instead of showing a number.

## Run it yourself

```bash
npm run bench
```

It takes under three minutes and rewrites `docs/public/benchmarks/results.json`. To compare two runs:

```bash
npm run bench:compare -- before.json after.json
```
