# Generate, watch and check

Generate once, regenerate while you edit, start your app after the first generation, and check generated files in CI.

## Generate

```sh
npx golem generate
```

`generate` writes the generated files that your editor and your bundler need. It skips a job whose inputs did not change since its last run, when the outputs of that job exist. It does not rewrite your calls ([Build your app](/guide/build)). `golem build` generates first, so a build needs no separate `generate` ([build](/reference/cli#build)). Configure [`golem.yaml`](/reference/config) first.

## Watch

```sh
npx golem watch
```

`watch` generates once. It then reruns when one of these changes:

- `golem.yaml`
- the tsconfig and its `extends` files
- a model or controller source, also a new one
- a file that a source imports
- an OpenAPI document or a manifest

It regenerates everything that depends on the change. A model-only edit does not rerun an unchanged SDK job. The models job reads the whole project, so an edit to any project source runs it again. The watcher does not poll remote references.

Type errors that come only from an outdated `.model.generated.ts` file do not block regeneration. A type error in a model source stops the write. A type error in another file is for `tsc` and `golem build` to report. A failed run prints its error and the watcher keeps running.

## Start an app after generation

Use `exec` when the app must not start before its generated files exist:

```sh
npx golem exec --watch -- npm run dev
```

The CLI generates first, then starts the child command and watches until the child exits. If generation fails, the child does not start. Without `--watch`, `exec` generates once and forwards the exit status of the child command. Regeneration does not restart your app. Use the reload of your framework.

## Check without writing

```sh
npx --no-install golem check
```

`check` exits with code 1 when a generated file is missing or stale, and it writes nothing. It also reports each `parse<T>()` call that no host can rewrite, with its file and line and what to run.

`check` needs generated files, so CI runs `golem build` or `golem generate` first ([ignore generated files](/reference/generated-files#gitignore)). When Golem has not generated yet, `check` stops with one message. The message tells you to run `golem generate` or `golem build` first.

With `--no-install`, `npx` fails when the project does not install Golem ([why](/guide/install#packages-for-each-generator)).

## Files golem owns

Golem replaces a file at an output path when it generated that file before. It also replaces a file that starts with the marker comment of the generator, even if Golem never recorded it. Any other file at an output path stops `generate` and `check` with an error that names the file. Remove or rename that file, or change the output path of the job.

When no job produces a generated file any more, `generate` deletes it. Golem deletes the file only if it still holds its generated content or its marker. Otherwise `generate` stops and names the file. Move the file or delete it yourself.

A file with a marker can also sit in an output folder at a path that no job produces, and Golem never recorded it. `generate` leaves that file alone. `check` reports it and fails.

Put custom behavior in your classes or application code. Do not edit `*.generated.ts` files. Ignore the `.golem/` folder.

## Recover after a failed run

Fix the model, API document or configuration, then run the same commands again:

```sh
npx golem generate
npx golem check
```

Generation recreates missing output. If an earlier job succeeded before a later job failed, its updated files remain. Fix the failing input and run generation again.

## Use another configuration

Paths in a [configuration](/reference/config) are relative to that file. Select another configuration with the [CLI](/reference/cli) option `--config`:

```sh
npx golem watch --config ./frontend/golem.yaml
```
