# Tests

Run tests in the golem test-runner image. Tier runs are offline.

| Command | Budget | Runs |
| --- | --- | --- |
| `npm run test -- <files or --test-name-pattern>` | 1 min | The tests you select. A packed or browser file packs first. |
| `npm run test:full` | 5 min | Unit tests, the TypeScript 6 lane, Go plugin tests and the packed model-only smoke test. Run before a commit. |
| `npm run test:acceptance` | 10 min | Full, the public-source and OpenAPI compliance checks, the acceptance unit tests, and the packed and browser tests. Run before a release. |
| `npm run test:prepare` | 5 min (plus a first-time image build), online | Builds the image and fills the npm, Go and packed caches. Runs no tests. Run it first, and again after a lockfile or image change. |
| `npm run docs:check` | 2 min | Builds the documentation site and checks it. |

Pass a test source path, such as `tests/serde.test.ts`, or any `node --test` flag.

## TypeScript 6 lane

Unit tests run on TypeScript 7. The lane runs the generator, analysis and controller suites again on TypeScript 6; its file list is `TYPESCRIPT6_FILES` in `scripts/test-tier.ts`, which also names what the lane leaves out and why. Full runs it as the `typescript 6` step.

The container's entrypoint installs TypeScript 6 once into `/cache/typescript6` and exports `GOLEM_TYPESCRIPT6_ROOT`. The lane sets `GOLEM_TYPESCRIPT_ROOT` to that path, which is how the compiler seam picks its backend. `tests/typescript-identity.test.ts` runs in the unit step and generates the same projects on both versions, then compares every artifact byte for byte.

Run the lane's files with `npm run test -- --typescript 6`, or run chosen files on TypeScript 6 with `npm run test -- --typescript 6 tests/model-tags.test.ts`. To point a focused run at any other TypeScript install, set `GOLEM_TYPESCRIPT_ROOT` in your shell; `run.sh` passes it into the container.

Name a unit test that is too slow for Full `tests/<name>.acceptance.ts` or `tests/openapi/<name>.acceptance.ts`. Acceptance runs it in its "acceptance unit" step.

After you change what a test installs, run `npm run test:prepare` before the next tier run. The TypeScript 6 lane changed the runner image, so every other checkout needs one `npm run test:prepare` after it updates to this change.

Full and Acceptance clear the container's Go build cache when it passes 9 GiB. The next run then rebuilds the ttsc plugin, which takes a few minutes longer.

## Failure messages

- `The golem test image … is missing or out of date`: run `npm run test:prepare`.
- `The npm cache is missing a package`: a test installs a package the cache lacks. Run `npm run test:prepare`.
- `Another golem test run holds /cache/run.lock`: one run uses the cache at a time. Wait for it.
- `Timed out after … ms`: the named command exceeded its limit and its processes were killed.
- `The … tier exceeded its …s ceiling and was stopped`: the whole run passed its time limit.

Results and timings land in `.cache/test-results/`. `npm run test:native` runs the unit and Go tests without Docker, for Windows and other Node versions.
