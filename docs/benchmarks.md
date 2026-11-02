# Benchmarks

Compare how fast Golem's generated code parses, stringifies and validates, and what each feature costs.

::: warning
Benchmarks are for reference purposes only.
:::

The page has two tabs.

**Speed per payload** shows the speed of Golem's three setups on each payload.

**What each feature costs** compares Golem with itself: validation on and off, `IModel` and `IObject`, many converted fields and none, and invalid input and valid input.

<BenchmarkChart>
<template #speed>

A column is one setup of Golem. Each setup turns JSON text into a value and back.

- **Golem (IObject)** uses an [`IObject` declaration](/guide/models#iobject-or-imodel). It gives plain objects, checks every rule, rejects unknown properties and converts [`TSerde` fields](/guide/serialization#change-the-json-form).
- **Golem (IModel)** uses an [`IModel` declaration](/guide/models#iobject-or-imodel). It gives instances of the generated class, with validation off.
- **Golem (IModel, validated)** uses the same declaration with Golem's own generated [validators](/reference/config#validation-profiles) on.

</template>
<template #simple-code>

#### Declarations for the Simple object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.object.model.ts#simple [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/golem.model.ts#simple [Golem (IModel)]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]

:::

</template>

<template #nested-code>

#### Declarations for the Nested object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.object.model.ts#nested [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/golem.constrained.model.ts#nested [Golem (IModel)]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]

:::

</template>

<template #array-code>

#### Declarations for the Large array payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.object.model.ts#array [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/golem.model.ts#array [Golem (IModel)]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/golem.ts#calls [Golem (IModel)]

:::

</template>

<template #checkout-code>

#### Declarations for the Checkout payload

::: code-group

<<< @/../tests/fixtures/models/serde-features/src/features.iobject.model.ts#checkout [Golem (IObject)]
<<< @/../tests/fixtures/models/serde-features/src/features.model.ts#checkout [Golem (IModel)]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem.ts#calls [Golem (IModel)]

:::

</template>

<template #checkout-plain-code>

#### Declarations for the Checkout, no conversion payload

::: code-group

<<< @/../tests/fixtures/models/serde-features/src/features.iobject.model.ts#checkout-plain [Golem (IObject)]
<<< @/../tests/fixtures/models/serde-features/src/features.model.ts#checkout-plain [Golem (IModel)]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem-object.ts#checkout-plain-calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem.ts#checkout-plain-calls [Golem (IModel)]

:::

</template>
</BenchmarkChart>

## Against hand-written code

Hand-written code copies each field and converts each date, and checks nothing. The table shows Golem's speed with validation on as a fraction of that code's speed, so 1.00 means equal. Golem checks the value before and after each conversion. Parse is `JSON.parse` then the hand-written decode; stringify is the hand-written encode then `JSON.stringify`.

| Model | Decode | Encode | Parse | Stringify |
| --- | --- | --- | --- | --- |
| Flat | 0.44 | 0.78 | 0.69 | 1.04 |
| Nested | 0.34 | 0.74 | 0.80 | 0.85 |
| Union | 0.32 | 0.66 | 0.61 | 0.82 |
| Array of 100 items | 0.47 | 0.77 | 0.73 | 0.81 |
| Tuple | 0.42 | 0.79 | 0.66 | 0.77 |
| Optional fields | 0.64 | 0.83 | 0.77 | 0.86 |

They were measured at commit 201b03e. To measure them on your machine, run `npm run bench:handwritten`.

## What is measured

A case is one payload, one operation and one setup. The tables show the median speed of a case in operations per second. The payloads differ in what they convert:

| Payload | What it converts |
| --- | --- |
| Simple object | Nothing |
| Nested object | Nothing |
| Large array | Nothing |
| Checkout | A few fields: money, a hex code and dates |
| Checkout, no conversion | Nothing |
| Serde none | Nothing, in 21 fields |
| Serde many | Every one of the same 21 fields |
| Union, tagged | One date in each of 100 events |
| Union, class-first | One date in each of 100 events |
| Temporal fields | All 20 fields, with the `temporal-polyfill` package as `Temporal` |
| Recursive model | Each of 106 nodes to its class |
| Unique strings | Nothing. Validate compares 1,000 strings |
| Unique objects | Nothing. Validate compares 100 objects |
| Unique small list | Nothing. Validate compares 3 objects |
| Unique nested objects | Nothing. Validate compares 20 objects that differ only in a nested field |
| Nest query | Six query strings to their declared types |
| Client call | The request body and the response of one generated client call |

The speed tab shows the first five payloads. The cost tab shows every payload. Nest query shows the Decode row only. Client call shows the Call row only: it runs the generated client against a stub `fetch` that builds a new `Response`, so its time includes that `Response` and no network.

The run is short, so read the ratios between setups in one run and not the absolute numbers. Do not compare numbers from two machines or from two runs.

1. **The same JSON text.** Every setup gets the same JSON text for a case and parses it in its own way.
2. **Proof before timing.** Each setup must turn its parsed value back into the original JSON. A setup that validates must reject each invalid variant of the payload. A setup that fails gets no number. These checks run in a separate process.
3. **One process for each setup, valid input only.** Each setup is timed in its own process, on valid input only. A validator runs slower after it has rejected differently shaped input, because V8 optimizes its generated function again for the new object shapes. The cost tab times invalid input in a separate process.
4. **A rotated order.** The run has two rounds, and the setup order reverses in the second round. The order of the cases rotates for each batch. In each round a case is warmed up for 120 ms and then timed in two batches of 90 ms, so the table shows the median of four batches.
5. **Every result is consumed.** A checksum reads each result, so the engine cannot remove the timed call.
6. **The spread is recorded.** Each case stores its minimum, median and maximum.

### What each feature costs

Each ratio on the second tab divides one speed by another speed, for the same operation on the same payload. A ratio below 1.00x means that the first speed is lower.

- **on/off** divides the speed with validation on by the speed with validation off. It is shown for `IModel` and for `IObject`. Off is a build with validation off. Validate has no off mode.
- **IModel/IObject** divides the `IModel` speed by the `IObject` speed, with validation on in both.
- **serde many/none** divides the speed on Serde many by the speed on Serde none, with validation on. It is shown on the Serde many rows only.
- **invalid/valid** divides the speed on one invalid value by the speed on a valid value, with validation on. It is shown for parse, decode and validate. Golem makes the path of a valid value fast, and the path of an invalid value builds the error and can be slower.

A dash means that the pair does not apply. "Not run" means that the run did not time the pair. The tab has no release column.

## Run the benchmarks

Reproduce one number on your machine. Name one setup and one payload:

```bash
npm run bench -- --adapters golem-object --payloads simple
```

- The payloads are `simple`, `nested`, `array`, `checkout`, `checkout-plain`, `serde-none`, `serde-many`, `union-tagged`, `union-class`, `temporal`, `recursive`, `unique-strings`, `unique-objects`, `unique-small`, `unique-nested`, `nest-query` and `client-call`.
- The run prints its tables to the console and writes `.cache/benchmark/results.json`.
- A name that is not valid stops the run before it starts, with exit code 2. The message lists the valid names.
- The run stores the machine load with the numbers, so stop other work on the machine first.
