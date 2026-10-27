# Tests

Run tests in the golem test-runner image. Tier runs are offline.

| Command | Budget | Runs |
| --- | --- | --- |
| `npm run test -- <files or --test-name-pattern>` | 1 min | The tests you select. A packed or browser file packs first. |
| `npm run test:full` | 5 min | Unit tests (not the identity corpus), the TypeScript 6 lane and the packed model-only smoke test. Run before a commit. Pack and the smoke test run beside the TypeScript 6 lane. |
| `npm run test:acceptance` | 10 min | Full, the public-source and OpenAPI compliance checks, the acceptance unit tests (the TypeScript identity corpus included), and the packed and browser tests. After the unit step, the TypeScript 6 lane runs beside a second chain: pack, the packed smoke test, packed, browser. The acceptance unit tests run last, alone. Run before a release. |
| `npm run test:prepare` | 5 min (plus a first-time image build), online | Builds the image and fills the npm, packed and typia plugin caches. Runs no tests. Run it first, and again after a lockfile or image change. |
| `npm run docs:check` | 2 min | Checks the docs prose rules and page inventory, then builds the documentation site and checks it. |

Pass a test source path, such as `tests/serde.test.ts`, or a `node --test` flag for the test files, such as `--test-name-pattern`. The run rejects the flags that set up the run itself (`--test-reporter`, `--test-concurrency`, `--test-timeout`, `--test-shard`) with exit 2. A path that names no file fails the step. A `*` works in the file name only, not in a directory (`tests/*.test.ts`, not `tests/**/x.test.ts`).

## TypeScript 6 lane

Unit tests run on TypeScript 7. The lane runs again only the tests that reach a place of the TypeScript 6 shim (`typescript-ts6.ts`, `build.ts`) that the identity test does not. A test file joins the lane when you tag its first line `// lane: typescript6 <place>`, where `<place>` names the shim place the file proves. The runner builds the lane from the tags, so no list needs an edit. Full runs it as the `typescript 6` step.

The container's entrypoint installs TypeScript 6 once into `/cache/typescript6` and exports `GOLEM_TYPESCRIPT6_ROOT`. The lane sets `GOLEM_TYPESCRIPT_ROOT` to that path, which is how the compiler seam picks its backend. `tests/typescript-identity.acceptance.ts` runs in the Acceptance tier's "acceptance unit" step, not in Full, because it generates the corpus twice (a Full run would spend about 262 CPU seconds on it). Run it with `npm run test -- tests/typescript-identity.acceptance.ts` after a change to the TypeScript seam (`typescript-ns.ts`, `typescript-ts6.ts`, `typescript-ts7.ts`, `typescript-types.ts`) or to a shim test that `scripts/test-tier.ts` tags; a focused run runs the files you name, so the seam change is the caller's cue. It generates the corpus projects on both versions and compares the generated files, the rewritten text and the diagnostics byte for byte. It also compiles the corpus once on TypeScript 6. When a claim needs a new TypeScript-version path, add a fixture to the corpus, in `tests/fixtures/models/identity/<claim>/` or in a group listed in `MODEL_GROUPS` (`tests/support/identity-corpus.ts`); a fixture anywhere else is not a case. When the claim is about shim behavior that a corpus fixture cannot show, such as how a program session updates after an edit, tag the test file.

Run the lane's files with `npm run test -- --typescript 6`, or run chosen files on TypeScript 6 with `npm run test -- --typescript 6 tests/model-tags.test.ts`. To point a focused run at another TypeScript 6 install, set `GOLEM_TYPESCRIPT_ROOT` in your shell; `run.sh` passes it into the container. A TypeScript 7 install must be the one Golem itself loads, or the run fails at load.

Name a unit test that is too slow for Full `tests/<name>.acceptance.ts` or `tests/openapi/<name>.acceptance.ts`. Acceptance runs it in its "acceptance unit" step.

The benchmark's typia adapter compiles with `ttsc`, which builds typia's Go plugin from source on first use and fetches its Go modules. Prepare compiles one small typia project so the plugin and the modules are cached. The entrypoint keeps them in `/cache/ttsc` (`TTSC_CACHE_DIR`) and `/cache/gomod` (`GOMODCACHE`), outside the work tree that each run resets, and sets `GOPROXY=off` in the offline tiers. A missing module then fails the run at once with a Go error: run `npm run test:prepare`.

After you change what a test installs, run `npm run test:prepare` before the next tier run. The record of cut and passed runs changed the runner image (the entrypoint holds it), so every other checkout needs one `npm run test:prepare` after it updates to this change.

## Linux lockfile

The checked-in `package-lock.json` comes from macOS and lacks the Linux platform binaries. `test:prepare` resolves a Linux lockfile online and keeps it in the cache volume at `/cache/linux-lock/deps-<hash>/package-lock.json`; the other tiers copy it and install offline. The hash covers only the fields of the root, `packages/*` and `examples/payments` `package.json` files that change the install: `name`, `version`, `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bundleDependencies`, `bundledDependencies`, `overrides`, `workspaces` and `packageManager`. A change to `scripts` or another field keeps the lockfile. Branches with different dependencies keep separate slots. When a tier reports `No Linux lockfile for the current package.json files`, run `npm run test:prepare`.

## Failure messages

- `The golem test image … is missing or out of date`: run `npm run test:prepare`.
- `The npm cache is missing a package`: a test installs a package the cache lacks. Run `npm run test:prepare`.
- `Another golem test run holds /cache/run.lock`: one run uses the cache at a time. Wait for it.
- `The … tier exceeded its …s ceiling and was stopped`: the whole run passed its time limit. The lines after it name each step that was running and the files of that step that started and did not finish. See [A hung test file](#a-hung-test-file).

## A hung test file

The tier ceiling is the one hang catcher. A test step sets no limit on a file or a test, and the helper that tests use to run a command sets none on a command, so a slow host does not fail a file that works. The ceilings are 180 s for `npm run test`, 450 s for Full, 600 s for Acceptance and 300 s for docs. They are the same on every machine.

A file that hangs stops the run at the ceiling, not sooner. The runner prints the ceiling message and each step that was cut, then the files of each step that started and did not finish. The hung file is among them. A file that was only slow when the ceiling hit appears there too.

```text
The focused tier exceeded its 180s ceiling and was stopped.
The focused step was running; 1 of 2 started files finished. Started and not finished:
  tests/hang.test.ts
```

Run the named file alone with `npm run test -- <file>` to see which test hangs.

## A cut or passed run is not run again from zero

Full and Acceptance keep a record of each run in the cache volume (`/cache/test-state/<tier>/`), so a rerun does not repeat work. The record is named by a key of what the run tests: the tier, a hash of the source tree (the files the container copies in, without `node_modules/`, `.build/`, `dist/` and the other folders the copy leaves out), the runner image, the Linux lockfile (its slot and content) and the host values that change what a tier checks (`PUBLIC_CONTENT_DENIED_TEXT`, `PUBLIC_CONTENT_REQUIRE_DENIED_TEXT` and `GOLEM_TYPESCRIPT_ROOT`). Any checkout of the same tree finds the same record. A change to any part is another key, and the run starts from zero. Records older than 14 days are removed.

- **Resume.** When the ceiling cuts Full or Acceptance, the runner keeps each file that passed and each step that ended, and prints one line (`Kept N passed files ...`). The next run of the same tier on the same tree prints one line that says what it resumes and from which record (`full resuming the cut run on tree <hash> from <record file> ...`), then runs only the files and steps that did not finish. The two runs count as one complete run of the tree. A file that failed runs again. The `pack` step always runs again in a resume (its packed set lives in `/cache/packed`, which keeps only the newest set, so another checkout can replace it; a present set is reused at once). A run that ends with a failed step drops the record, so the next run starts from zero.
- **Skip.** A run that ends with every file of every lane passed prints `<tier> complete: ...` and leaves a marker for its key. A rerun of that tier on the same tree exits 0 before the install and the build, with one line that names the earlier pass. A run that executes (`--again`) and does not end passing, because it failed or was cut, removes the marker of its tree first, so the next plain run does not skip on an old pass. Docs and focused runs keep no record.
- **`--again`.** `npm run test:full -- --again` (or `test:acceptance`) runs the tier even when its tree passed, ignores any record of a cut run and starts from zero.
- **Complete.** The last line of Full and Acceptance says `<tier> complete` only when every file of every lane has a pass in this tree, in one run or in a resumed pair, and lists the parts (each run, cut or passed, with its seconds). Otherwise it says `<tier> incomplete` and names what has no result. A tool that reads the output, such as `suite.record`, takes `complete` as the sign of a whole run. The results folder of a resumed pair holds the files of the last part only (`<tier>-timings.json`, `<tier>.*.files.jsonl`). A complete run also writes `<tier>-complete.json` there, with the parts and the seconds of each file over all parts (a file that two steps run counts both); a tool that records the seconds of each file reads that file, not `<tier>-timings.json`.

The tier ceilings do not change: a resumed run has the same ceiling as any run, and the ceiling stays the one hang catcher.

### Wait for host load

Before Full and Acceptance start their tests (after the build, before the ceiling clock starts), the runner reads the 1 minute load average of the container's kernel. When it is above the limit, it prints one line with the load and waits, up to the wait bound, then starts anyway with a second line. The wait does not use the tier ceiling.

| Option | Default | Meaning |
| --- | --- | --- |
| `--load-limit <load>` | the CPU count of the container (`nproc`) | The load above which the run waits. |
| `--load-wait <seconds>` | 240 | The longest wait, in whole seconds; after it the run starts. |

The defaults follow one rule for every machine. The unit step runs up to 8 files at once, so the run alone makes a load of about the CPU count; a start above that load doubles a queue that is already full. The recorded cuts (T-359) happened at container load 15 to 20, two to two and a half times the 8 CPUs of the Docker VM. Load does not predict a pass alone (Full has passed at load 17 to 36), so the wait is bounded and never refuses to run. Example: `npm run test:full -- --load-limit 12 --load-wait 120`.

## File order

A step starts its files longest first, so one slow file does not start last and set the step's time. The order is the seconds recorded for the step by the last run of the same tier in which that step passed. The record is `test-order/<tier>.json` in the cache volume, beside `packed/`, so a new checkout or worktree starts in the same order. A record from another branch only changes the order. Files with no record start first, in path order. With no record, or one that cannot be read (the run says so), every file starts in path order. The order changes no result. Spec output and the TAP numbers follow the start order, and the spec output of a file appears after the files that started before it have reported.

`node --test` sorts its files by path. The runner starts the files with `run({ files })` of `node:test` (`scripts/test-run-ordered.ts`), which keeps the given order, and wires the same spec, TAP and file-timing reporters and the same exit status (1 when a test fails).

## Results and timings

Results land in `.cache/test-results/`: one TAP file for each test step (`<tier>.<step>.tap`), and `<tier>-timings.json`. A tier run replaces only the files of its own tier, so a docs or focused run after a full run keeps the full run's results. The runner writes the timings file when a step starts and again when it ends, so a run that the ceiling stops keeps every finished step. Its fields:

- `timings`: one entry for each finished step, with `label`, `seconds`, `status`, `load_start`, `load_end` and `file_seconds`.
- `load_start` and `load_end`: the 1, 5 and 15 minute load averages when the step began and ended, also printed on the step's start and end lines as `load (container kernel)`. `run.sh` prints `load (host)` once, at the start of the run, before the container starts. The container line shows the load of the container's kernel only (on Docker Desktop, the Linux VM); the host line shows the machine, including processes outside Docker. Read both before you take a ceiling hit for a regression.
- `file_seconds`: the seconds of each test file, keyed by source path (`tests/serde.test.ts`), summed over the steps. A file that the TypeScript 6 lane reruns counts both runs. The entries in `timings` hold the seconds of each step alone; steps that run beside each other overlap, so their seconds add up to more than the total.
- `running`: the steps that were running at the last write. It is absent when every step ended.

A file's seconds are the wall time of its test process, from start to exit, including the load of the file. Each test step also writes `<tier>.<step>.files.jsonl`: one line when a file starts and one line, with its seconds and `passed` (true when every test of the file passed and the file did not crash), when it ends. When the ceiling stops a step, that step's files are only in this file.

`npm run test:native` runs the unit tests without Docker, for Windows and other Node versions. It writes no results. It runs outside the container, so it has no ceiling and no hang catcher: a hung file blocks it until you stop it.
