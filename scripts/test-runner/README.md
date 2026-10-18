# Tests

Run tests in the golem test-runner image. Tier runs are offline.

| Command | Budget | Runs |
| --- | --- | --- |
| `npm run test -- <files or --test-name-pattern>` | 1 min | The tests you select. A packed or browser file packs first. |
| `npm run test:full` | 5 min | Unit tests, the TypeScript 6 lane and the packed model-only smoke test. Run before a commit. |
| `npm run test:acceptance` | 10 min | Full, the public-source and OpenAPI compliance checks, the acceptance unit tests, and the packed and browser tests. Run before a release. |
| `npm run test:prepare` | 5 min (plus a first-time image build), online | Builds the image and fills the npm, packed and typia plugin caches. Runs no tests. Run it first, and again after a lockfile or image change. |
| `npm run docs:check` | 2 min | Builds the documentation site and checks it. |

Pass a test source path, such as `tests/serde.test.ts`, or any `node --test` flag.

## TypeScript 6 lane

Unit tests run on TypeScript 7. The lane runs the generator, analysis and controller suites again on TypeScript 6; its file list is `TYPESCRIPT6_FILES` in `scripts/test-tier.ts`. A file is in the list only when it reaches the compiler seam or the backend selection (`GOLEM_TYPESCRIPT_ROOT`); the list names that path for each group and what the lane leaves out and why. Full runs it as the `typescript 6` step.

The container's entrypoint installs TypeScript 6 once into `/cache/typescript6` and exports `GOLEM_TYPESCRIPT6_ROOT`. The lane sets `GOLEM_TYPESCRIPT_ROOT` to that path, which is how the compiler seam picks its backend. `tests/typescript-identity.test.ts` runs in the unit step and generates the same projects on both versions, then compares every artifact byte for byte.

Run the lane's files with `npm run test -- --typescript 6`, or run chosen files on TypeScript 6 with `npm run test -- --typescript 6 tests/model-tags.test.ts`. To point a focused run at another TypeScript 6 install, set `GOLEM_TYPESCRIPT_ROOT` in your shell; `run.sh` passes it into the container. A TypeScript 7 install must be the one Golem itself loads, or the run fails at load.

Name a unit test that is too slow for Full `tests/<name>.acceptance.ts` or `tests/openapi/<name>.acceptance.ts`. Acceptance runs it in its "acceptance unit" step.

The benchmark's typia adapter compiles with `ttsc`, which builds typia's Go plugin from source on first use and fetches its Go modules. Prepare compiles one small typia project so the plugin and the modules are cached. The entrypoint keeps them in `/cache/ttsc` (`TTSC_CACHE_DIR`) and `/cache/gomod` (`GOMODCACHE`), outside the work tree that each run resets, and sets `GOPROXY=off` in the offline tiers. A missing module then fails the run at once with a Go error: run `npm run test:prepare`.

After you change what a test installs, run `npm run test:prepare` before the next tier run. The TypeScript 6 lane changed the runner image, so every other checkout needs one `npm run test:prepare` after it updates to this change.

## Failure messages

- `The golem test image … is missing or out of date`: run `npm run test:prepare`.
- `The npm cache is missing a package`: a test installs a package the cache lacks. Run `npm run test:prepare`.
- `Another golem test run holds /cache/run.lock`: one run uses the cache at a time. Wait for it.
- `The … tier exceeded its …s ceiling and was stopped`: the whole run passed its time limit. The line after it names the step that was running and the files of that step that started and did not finish. See [A hung test file](#a-hung-test-file).

## A hung test file

The tier ceiling is the one hang catcher. A test step sets no limit on a file or a test, and the helper that tests use to run a command sets none on a command, so a slow host does not fail a file that works. The ceilings are 180 s for `npm run test`, 450 s for Full, 600 s for Acceptance and 300 s for docs. They are the same on every machine.

A file that hangs stops the run at the ceiling, not sooner. The runner prints the ceiling message and the step that was cut, then the files of that step that started and did not finish. The hung file is among them. A file that was only slow when the ceiling hit appears there too.

```text
The focused tier exceeded its 180s ceiling and was stopped.
The focused step was running; 1 of 2 started files finished. Started and not finished:
  tests/hang.test.ts
```

Run the named file alone with `npm run test -- <file>` to see which test hangs.

## Results and timings

Results land in `.cache/test-results/`: one TAP file for each test step, and `<tier>-timings.json`. The runner writes the timings file when a step starts and again when it ends, so a run that the ceiling stops keeps every finished step. Its fields:

- `timings`: one entry for each finished step, with `label`, `seconds`, `status` and `file_seconds`.
- `file_seconds`: the seconds of each test file, keyed by source path (`tests/serde.test.ts`), summed over the steps. A file that the TypeScript 6 lane reruns counts both runs. The entries in `timings` hold the seconds of each step alone.
- `running`: the step that was running at the last write. It is absent when every step ended.

A file's seconds are the wall time of its test process, from start to exit, including the load of the file. Each test step also writes `<step>.files.jsonl`: one line when a file starts and one line, with its seconds, when it ends. When the ceiling stops a step, that step's files are only in this file.

`npm run test:native` runs the unit tests without Docker, for Windows and other Node versions. It writes no results. It runs outside the container, so it has no ceiling and no hang catcher: a hung file blocks it until you stop it.
