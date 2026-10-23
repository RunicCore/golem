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

<<< @/../scripts/benchmark/fixtures/features/features.iobject.model.ts#checkout [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/features/features.model.ts#checkout [Golem (IModel)]

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

<<< @/../scripts/benchmark/fixtures/features/features.iobject.model.ts#checkout-plain [Golem (IObject)]
<<< @/../scripts/benchmark/fixtures/features/features.model.ts#checkout-plain [Golem (IModel)]

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
| Flat | 0.49 | 0.79 | 0.74 | 1.06 |
| Nested | 0.36 | 0.65 | 0.83 | 0.85 |
| Union | 0.40 | 0.71 | 0.70 | 0.91 |
| Array of 100 items | 0.53 | 0.78 | 0.75 | 0.82 |
| Tuple | 0.44 | 0.76 | 0.71 | 0.85 |
| Optional fields | 0.64 | 0.85 | 0.77 | 0.84 |

They were measured at commit c7513ad. To measure them on your machine, run `npm run bench:handwritten`.

## What is measured

A case is one payload, one operation and one setup. The tables show the median speed of a case in operations per second. The payloads Simple object, Nested object and Large array have no converting fields. Checkout converts a few fields (money, a hex code and dates). Checkout, no conversion converts none. The cost tab adds Serde none and Serde many. They have the same 21 fields, and in Serde many every field converts.

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

A dash means that the pair does not apply. "Not run" means that the run did not time the pair. The tab has no release column. The release check below writes its result to a file and not to this page.

## Run it yourself

```bash
npm run bench
```

It takes about 2.5 minutes (145 seconds on an Apple M4). It prints its tables to the console and writes the full results to `scripts/benchmark/results.json`. The docs build reads that file and shows the Golem numbers. Stop other work on the machine first. The run stores the host load with the numbers.

To run only some setups or payloads, name them with `--adapters` and `--payloads`:

```bash
npm run bench -- --adapters golem-object --payloads simple,nested
```

The payloads are `simple`, `nested`, `array`, `checkout`, `checkout-plain`, `serde-none` and `serde-many`. A name that is not valid stops the run before it starts, with exit code 2, and the message lists the valid names. A run with `--adapters` or `--payloads` writes `.cache/benchmark/results.json` and leaves the committed results unchanged.

### Check a release

Before you cut a release, compare this checkout with an earlier one:

```bash
npm run bench:release -- --base <git ref>
```

The base is a branch, a tag or a commit. The command exports the base into `.cache/benchmark/release` and builds it there. Then it times both sides in one session, in alternating rounds, with a native JSON control on both sides. A ratio between two separate days is not evidence. The release check times Golem only, so `--adapters` accepts `golem-object`, `golem-object-off`, `golem` and `golem-validated`, and `--payloads` accepts the payloads above. `golem-object-off` is `IObject` built with validation off.

The noise band comes from the control on both sides. A valid-path case is slower when this checkout is below the base by more than the band in both halves of the rounds. One slower case stops the release. Invalid input is shown and has no verdict.

The exit code is 0 when no case is slower, 1 when a case is slower, and 2 when the call is wrong (for example, a missing or unknown base). The command writes the full result to `.cache/benchmark/release.json`. It changes nothing else in the repository.

A check of one adapter on one payload takes about 30 seconds. A full check takes about 5 minutes on an Apple M4. The first check of a base also builds it, and later checks of the same commit reuse that build.
