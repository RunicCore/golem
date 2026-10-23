# Serialization benchmarks

Compare how fast Golem's generated code parses, stringifies and validates next to libraries that do the same job.

::: warning
Benchmarks are for reference purposes only.
:::

The page has two tabs.

**Compare libraries** puts Golem next to libraries that do the same job, and ranks them in each row. Libraries are ranked inside their own group only. Two groups do different jobs (for example, one checks values and the other does not), so a rank never compares libraries of two groups.

**What each feature costs** compares Golem with itself: validation on and off, `IModel` and `IObject`, many converted fields and none, and invalid input and valid input.

<BenchmarkChart>
<template #plain>

Each library turns JSON into plain objects, checks every rule and rejects unknown properties. Golem uses an [`IObject` declaration](/guide/models#iobject-or-imodel) and also converts dates and [`TSerde` fields](/guide/serialization#change-the-json-form); Typia and [Ajv](https://ajv.js.org) check every rule but do not convert values, so they cannot run the Checkout payload; all four run Checkout, no conversion, where dates stay strings and Ajv checks the date-time format with an expression. Ajv is an outside library, here for comparison. It compiles a JSON Schema to a function, and the timed calls pair that function with `JSON.parse` and `JSON.stringify`.

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
<<< @/../scripts/benchmark/fixtures/upstream/ajv.ts#simple [Ajv]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.ts#calls [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#calls [Zod]
<<< @/../scripts/benchmark/fixtures/upstream/ajv.ts#calls [Ajv]

:::

</template>
<template #plain-nested-code>

#### Declarations for the Nested object payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.object.model.ts#nested [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.models.ts#nested [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#nested [Zod]
<<< @/../scripts/benchmark/fixtures/upstream/ajv.ts#nested [Ajv]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.ts#calls [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#calls [Zod]
<<< @/../scripts/benchmark/fixtures/upstream/ajv.ts#calls [Ajv]

:::

</template>
<template #plain-array-code>

#### Declarations for the Large array payload

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem.object.model.ts#array [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.models.ts#array [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#array [Zod]
<<< @/../scripts/benchmark/fixtures/upstream/ajv.ts#array [Ajv]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/upstream/golem-object.ts#calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.ts#calls [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#calls [Zod]
<<< @/../scripts/benchmark/fixtures/upstream/ajv.ts#calls [Ajv]

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
<template #plain-checkout-plain-code>

#### Declarations for the Checkout, no conversion payload

::: code-group

<<< @/../scripts/benchmark/fixtures/features/features.iobject.model.ts#checkout-plain [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.models.ts#checkout-plain [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#checkout-plain [Zod]
<<< @/../scripts/benchmark/fixtures/upstream/ajv.ts#checkout-plain [Ajv]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem-object.ts#checkout-plain-calls [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/upstream/typia.ts#checkout-plain-calls [Typia]
<<< @/../scripts/benchmark/fixtures/upstream/zod.ts#calls [Zod]
<<< @/../scripts/benchmark/fixtures/upstream/ajv.ts#checkout-plain-calls [Ajv]

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
<template #classes-checkout-plain-code>

#### Declarations for the Checkout, no conversion payload

::: code-group

<<< @/../scripts/benchmark/fixtures/features/features.model.ts#checkout-plain [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/features/features-class-transformer.models.ts#checkout-plain [class-transformer]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem.ts#checkout-plain-calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/features/comparison-features-class-transformer.ts#checkout-plain-calls [class-transformer]

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
<template #validated-classes-checkout-plain-code>

#### Declarations for the Checkout, no conversion payload

::: code-group

<<< @/../scripts/benchmark/fixtures/features/features.model.ts#checkout-plain [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/features/features-class-validator.models.ts#checkout-plain [class-transformer + class-validator]

:::

#### Timed calls

::: code-group

<<< @/../scripts/benchmark/fixtures/features/comparison-features-golem.ts#checkout-plain-calls [Golem (IModel)]
<<< @/../scripts/benchmark/fixtures/features/comparison-features-class-validator.ts#checkout-plain-calls [class-transformer + class-validator]

:::

</template>
</BenchmarkChart>

## Against hand-written code

Hand-written code copies each field and converts each date, and checks nothing. The table shows Golem's speed with validation on as a fraction of that code's speed, so 1.00 means equal. Golem checks the value before and after each conversion. Parse is `JSON.parse` then the hand-written decode; stringify is the hand-written encode then `JSON.stringify`.

| Model | Decode | Encode | Parse | Stringify |
| --- | --- | --- | --- | --- |
| Flat | 0.49 | 0.79 | 0.74 | 1.06 |
| Nested | 0.36 | 0.65 | 0.83 | 0.85 |
| Union | 0.40 | 0.71 | 0.70 | 0.91 |
| Array of 100 items | 0.53 | 0.78 | 0.75 | 0.82 |
| Tuple | 0.44 | 0.76 | 0.71 | 0.85 |
| Optional fields | 0.64 | 0.85 | 0.77 | 0.84 |

They were measured at commit c7513ad. To measure them on your machine, run `npm run bench:typia`.

## What is measured

A case is one payload, one operation and one library. The tables show the median speed of a case in operations per second. The payloads Simple object, Nested object and Large array have no converting fields. Checkout converts a few fields (money, a hex code and dates). Checkout, no conversion converts none. The cost tab adds Serde none and Serde many. They have the same 21 fields, and in Serde many every field converts.

The run is short, so read the ratios between libraries in one run and not the absolute numbers. Do not compare numbers from two machines or from two runs.

### Fairness rules

1. **The same job in a group.** A group holds only libraries that do the same job. A library that does less work in a case keeps its number, with a mark and a note on that cell. For example, class-validator does not reject unknown properties.
2. **The same JSON text.** Every library gets the same JSON text for a case and parses it in its own way. No library gets a value that was decoded for it.
3. **Proof before timing.** Each library must turn its parsed value back into the original JSON. A library that validates must reject each invalid variant of the payload. A library that fails gets no number. These checks run in a separate process.
4. **The documented best setup.** Each library runs in the setup that its own documentation shows. For example, Typia runs through its transform build step, and Ajv compiles each schema once. No library gets tuning that its documentation does not show.
5. **One process for each library, valid input only.** Each library is timed in its own process, on valid input only. A validator runs slower after it has rejected differently shaped input, because V8 optimizes its generated function again for the new object shapes. The cost tab times invalid input in a separate process.
6. **A rotated order.** The run has two rounds, and the library order reverses in the second round. The order of the cases rotates for each batch. In each round a case is warmed up for 120 ms and then timed in two batches of 90 ms, so the table shows the median of four batches.
7. **Every result is consumed.** A checksum reads each result, so the engine cannot remove the timed call.
8. **The noise is recorded.** Each case stores its minimum, median and maximum. Each run stores the host load and the spread of a control. The control is native `JSON.parse` and `JSON.stringify`, timed in its own process.
9. **Releases compare in one session.** The release check compares two checkouts in one session, with their runs interleaved and with the control. A ratio between two separate days is not evidence.
10. **A reason, not a number.** A library that cannot do a case shows the reason. For example, Typia checks every rule but does not convert values.

### Ranks and ties

A rank orders the libraries of one group in one row. A row is one payload and one operation, and the score of a library is its median speed. Rank 1 is the fastest. There is no rank across groups, and no claim that one library is the fastest overall.

Libraries tie when they are inside the noise band of the run. The band is the spread of the control in that run, and the legend under the table shows it. A library ties the fastest library of its row when it is within the band of that library. Tied libraries share a rank, and a tied cell shows `=#` before the rank. The next rank is skipped, so two libraries at rank 1 are followed by rank 3.

The group score of a library is the geometric mean of its speed divided by the speed of the fastest library, over the rows that every library of the group can run. The fastest library of a row scores 1.00 in that row. The table shows the score with "n of m rows": n rows count, out of m rows in the group. A row where a library cannot run the case does not count.

### What each feature costs

Each ratio on the second tab divides one speed by another speed, for the same operation on the same payload. A ratio below 1.00x means that the first speed is lower.

- **on/off** divides the speed with validation on by the speed with validation off. It is shown for `IModel` and for `IObject`. Off is a build with validation off. Validate has no off mode.
- **IModel/IObject** divides the `IModel` speed by the `IObject` speed, with validation on in both.
- **serde many/none** divides the speed on Serde many by the speed on Serde none, with validation on. It is shown on the Serde many rows only.
- **invalid/valid** divides the speed on one invalid value by the speed on a valid value, with validation on. It is shown for parse, decode and validate. It is shown, not ranked: Golem makes the path of a valid value fast, and the path of an invalid value builds the error and can be slower.

A dash means that the pair does not apply. "Not run" means that the run did not time the pair. No cell on this tab has a rank. The tab has no release column. The release check below writes its result to a file and not to this page.

## Run it yourself

```bash
npm run bench
```

It takes about 2.5 minutes (145 seconds on an Apple M4) and rewrites `docs/public/benchmarks/results.json` with both tables. Stop other work on the machine first. The run stores the host load and the spread of the control with the numbers.

To run only some libraries or payloads, name them with `--adapters` and `--payloads`:

```bash
npm run bench -- --adapters golem-object,zod --payloads simple,nested
```

The adapters are `golem-object`, `golem-object-off`, `control`, `typia`, `zod`, `ajv`, `golem`, `class-transformer`, `golem-validated` and `class-validator`. `golem-object-off` is `IObject` built with validation off, and it feeds the cost tab. `control` is native JSON, and it sets the noise band. Neither is a column of the compare tab. The payloads are `simple`, `nested`, `array`, `checkout`, `checkout-plain`, `serde-none` and `serde-many`. A name that is not in these lists stops the run before it starts, with exit code 2, and the message lists the valid names. A run with `--adapters` or `--payloads` writes `.cache/benchmark/results.json` and leaves the results of the page unchanged.

### Check a release

Before you cut a release, compare this checkout with an earlier one:

```bash
npm run bench:release -- --base <git ref>
```

The base is a branch, a tag or a commit. The command exports the base into `.cache/benchmark/release` and builds it there. Then it times both sides in one session, in alternating rounds, with the control on both sides. It times Golem only, so `--adapters` accepts `golem-object`, `golem-object-off`, `golem` and `golem-validated`, and `--payloads` accepts the payloads above.

The noise band comes from the control on both sides. A valid-path case is slower when this checkout is below the base by more than the band in both halves of the rounds. One slower case stops the release. Invalid input is shown and has no verdict.

The exit code is 0 when no case is slower, 1 when a case is slower, and 2 when the call is wrong (for example, a missing or unknown base). The command writes the full result to `.cache/benchmark/release.json`. It changes nothing else in the repository.

A check of one adapter on one payload takes about 30 seconds. A full check takes about 5 minutes on an Apple M4. The first check of a base also builds it, and later checks of the same commit reuse that build.
