# Generate, watch and check

Generate once, regenerate while you edit, start your app after the first generation, and check generated files in CI.

`golem watch` regenerates when inputs change. Configure [`golem.yaml`](/reference/config) first.

```sh
npx golem watch
```

- `golem exec --watch -- <command>` generates before starting a child process.
- `golem check` reports stale output without writing.
- `golem build` generates first, then compiles ([build](/reference/cli#build)).

`golem generate` and `golem watch` write generated code for your editor and your bundler. They do not rewrite your calls. `golem build`, the bundler plugins and the Node loader do that, and each scans your files itself ([TypeScript setup](/guide/install#typescript-setup)).

The CLI records generated paths in `.golem/outputs.json`, so it can
delete files it generated earlier that are no longer produced.

## Regenerate while editing

Watch reruns when `golem.yaml`, the tsconfig and its `extends` files, a file that matches a configured suffix (also a new one), a file those import, an OpenAPI document or a manifest changes, and regenerates everything that depends on it. A model-only edit does not rerun an unchanged SDK job. The models job reads the whole project, so an edit to any project source runs it again. Type errors that come only
from an outdated `.model.generated.ts` file don't block regeneration. A type error in a model source stops the write; a type error in another file is for `tsc` and `golem build` to report. Remote references are
fetched during generation; the watcher does not poll them. Each model and
controller job keeps its TypeScript compiler process running between runs; it
closes when the watcher stops.

## Start an application after generation

Use `exec` when the application must not start before its generated files exist:

```sh
npx golem exec --watch -- npm run dev
```

The CLI generates first, then starts the child command and keeps watching until
the child exits. If generation fails, the child is not started. Without
`--watch`, `exec` generates once and forwards the child command's exit status.
Regeneration doesn't restart your app; use your framework's own reload.

## Check without writing

```sh
npx --no-install golem check
```

`--no-install` makes `npx` fail when the project doesn't install golem, instead of fetching the unrelated `golem` package from npm ([Install](/guide/install#packages-per-generator)).

`check` exits with code 1 when a generated file is missing, stale or
unrecorded, and writes nothing. It also reports each `parse<T>()` call that no host can rewrite, with its file and line and what to run. A project that commits its generated files runs `check` in CI, and commits `.golem/outputs.json` and `.golem/codec-keys.json` with them so the check knows which paths belong to
each job. A project that ignores its generated files runs `golem generate` or `golem build` in CI instead ([what to commit](/reference/generated-files#gitignore)).

## Generated files and the inventory

Generation skips a job whose inputs, options and generator code did not change since its last run, when its outputs exist. `.golem/jobs.json` keeps what each job read; do not commit it. Generation replaces the files it generated before. Put custom behavior in your classes or application code; do not edit `*.generated.ts` files.

`.golem/outputs.json` lists the files written by each job, so the CLI
can delete files it generated earlier that are no longer produced. Identical
content keeps its modification time. Changed output is replaced even if it was
edited or its generated marker was removed. `check` flags files that carry a
generator marker but aren't in `.golem/outputs.json`; other files are
left alone.

Each recorded path also stores which job and package generated it and a
digest of its content. The job and package keep two jobs from claiming the
same generated path; the digest lets `check` and `generate` tell whether a
file's content, or the inventory's own record of it, no longer matches what
generation would produce now, even when the file's modification time was left
untouched.

Configured destinations such as `output: ../shared-sdk` are relative to the
configuration file and follow the same rules. Colliding outputs and paths that
escape a destination through a symbolic link are rejected before generation
writes them.

## Recover after a failed run

Fix the model, API document or configuration, then rerun the same commands:

```sh
npx golem generate
npx golem check
```

Generation recreates missing output and refreshes the inventory. If an earlier
job succeeded before a later job failed, its updated files remain available;
fix the failing input and run generation again. An unrecorded generated-looking
file is reported but left untouched because the CLI cannot infer who owns it.

## Use another configuration

Paths in a [configuration](/reference/config) are relative to that file. Select another project
configuration explicitly with the [CLI](/reference/cli) option `--config`:

```sh
npx golem watch --config ./frontend/golem.yaml
```
