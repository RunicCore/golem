# Run the benchmarks

Run the benchmarks on your machine, or compare this checkout with an earlier release.

The [benchmarks page](/benchmarks) shows the committed results and explains what each case measures.

## Run every case

```bash
npm run bench
```

- The run takes about 2.5 minutes (145 seconds on an Apple M4).
- It prints its tables to the console.
- It writes the full results to `scripts/benchmark/results.json`. The docs build reads that file and shows the Golem numbers.
- It stores the host load with the numbers, so stop other work on the machine first.

## Run some setups or payloads

Name them with `--adapters` and `--payloads`:

```bash
npm run bench -- --adapters golem-object --payloads simple,nested
```

- The payloads are `simple`, `nested`, `array`, `checkout`, `checkout-plain`, `serde-none`, `serde-many`, `union-tagged` and `union-class`.
- A name that is not valid stops the run before it starts, with exit code 2. The message lists the valid names.
- A run with `--adapters` or `--payloads` writes `.cache/benchmark/results.json`. It leaves the committed results unchanged.

## Check a release

Before you cut a release, compare this checkout with an earlier one:

```bash
npm run bench:release -- --base <git ref>
```

The command does these steps:

1. It exports the base into `.cache/benchmark/release` and builds it there.
2. It times both sides in one session, in alternating rounds, with a native JSON control on both sides.

A ratio between two separate days is not evidence. Use one session.

### Choose the base and the cases

- `--base` is a branch, a tag or a commit.
- `--adapters` accepts `golem-object`, `golem-object-off`, `golem` and `golem-validated`. `golem-object-off` is `IObject` built with validation off.
- `--payloads` accepts the payloads of the previous section.

The release check times Golem only.

### Read the verdict

- The noise band comes from the control on both sides.
- A valid-path case is slower when this checkout is below the base by more than the band in both halves of the rounds.
- One slower case stops the release.
- Invalid input is shown and has no verdict.

The exit code tells the outcome:

| Code | Meaning |
| --- | --- |
| 0 | No case is slower |
| 1 | A case is slower |
| 2 | The call is wrong, for example a missing or unknown base |
| 3 | The check failed and gave no verdict, for example a failed build or a worker crash |

On code 3 the command prints the error and its cause. The command writes the full result to `.cache/benchmark/release.json`. It changes nothing else in the repository.

| Check | Time on an Apple M4 |
| --- | --- |
| One adapter on one payload | About 30 seconds |
| A full check | About 5 minutes |

The first check of a base also builds it. Later checks of the same commit reuse that build.
