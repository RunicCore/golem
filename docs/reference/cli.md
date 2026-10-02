# CLI

The `golem` command comes from `@exprtlabs/golem`. Run it from the
directory that contains `golem.yaml`. It resolves the configuration,
runs the configured generators, and writes their artifacts to the configured
destinations. The inventory (`.golem/outputs.json`) records which
generated files each job produced.

A job replaces a file at one of its output paths only when the inventory
records it or the file starts with that generator's marker comment. Any other
file there stops `generate` and `check` with an error naming it; remove or
rename the file, or change the job's output path.

```text
Usage: golem <generate|check|watch|exec> [--config golem.yaml]
       golem exec [--watch] -- <command> [args...]
       golem build [-p tsconfig.json] [--watch]
       golem --help
```

Running `golem` with no arguments, or with `--help` or `-h`, prints
usage and exits.

## Commands

| Command | What it does |
| --- | --- |
| `generate` | Writes all outputs and the inventory. |
| `check` | Generates the expected artifact set in memory and fails when files are missing, stale, conflicting or obsolete inventoried outputs remain. It does not write files. |
| `watch` | Generates once, then reruns affected jobs when observed configuration, API, model, TypeScript or manifest inputs change. |
| `exec -- <command> [args...]` | Generates once, starts the child command only after generation succeeds, and forwards its exit status and signals. |
| `exec --watch -- <command> [args...]` | Does the same and keeps the generator watching until the child exits. |
| `build [-p tsconfig.json] [--config golem.yaml] [--watch]` | Type-checks your TypeScript sources, then emits JavaScript with the generic serde calls rewritten. |

`generate` runs configured jobs in the order set by
[configuration](/reference/config). `exec` requires the `--` separator.
Arguments after it are passed to the child process unchanged. `--watch` is
valid only with `exec`; unknown options fail before generation starts.

## Build

`golem build` replaces `tsc -p` for a project that calls `parse<T>()`, `stringify<T>()` and the other generic serde calls, or extends a generated model class. It checks the sources you wrote, so an error points at your line, and emits JavaScript with those calls rewritten.

```sh
npx golem build
npx golem build -p packages/api/tsconfig.json
npx golem build --watch
npx golem build --config packages/api/golem.yaml
```

`-p` takes a tsconfig file or a directory that holds `tsconfig.json`; it defaults to `./tsconfig.json`. The build runs the TypeScript in your project, TypeScript 6.0 or 7, and prints its messages unchanged. A failed check stops the build before any JavaScript is written; when the tsconfig asks for declarations, the check may already have written them. With `--watch` the build repeats when a source, tsconfig or `golem.yaml` changes.

A build never edits your source files. It writes the declarations and JavaScript the tsconfig asks for into `outDir`, and its own files into `.golem/`: the rewrite index (`rewrites.json`), and, per tsconfig under `.golem/build/<tsconfig name>/`, the incremental state and a copy of your sources with the calls rewritten. Two tsconfig files in one directory never share that state. Add `.golem/` to `.gitignore`. A build of the project's `tsconfig.json` refreshes `.golem/rewrites.json` itself, so a source edited since `golem generate` is not an error. A build of any other tsconfig, such as `tsconfig.build.json`, keeps its rewrites in memory and leaves the index alone. Delete `outDir` and the next build writes it again.

### What the tsconfig needs

- `outDir` is required.
- Every source file the program reads lies under the tsconfig's directory. A relative import that leaves it fails the build and names the file; build the package that holds the file instead.
- `rootDir` lies under the tsconfig's directory.
- `extends` may name a file anywhere. `paths` and `baseUrl` targets under the directory work as they do for `tsc`.
- `outFile`, `rootDirs`, `inlineSourceMap` and `sourceRoot` are not supported. `-b` and `--build` are rejected: `golem build does not support project references (-b); run golem build -p <tsconfig> per project.`

The tsconfig's directory is the project root, and `.golem/rewrites.json` lives there. `golem generate` writes the index to the same place: for a models or controllers job it uses the directory of the tsconfig that holds the job's root, so a package without a tsconfig of its own is indexed at the parent tsconfig that includes it. The index covers every file that tsconfig includes, so a parent tsconfig that includes several packages indexes and builds all of them. `--config` names the `golem.yaml` the build reads, and defaults to `golem.yaml` in the working directory, as for `generate`. If one of its `controllers` jobs reads a root whose tsconfig is this project's tsconfig, the build also adds the Nest codec decorators. Two `golem.yaml` files whose jobs map to the same parent tsconfig share one index, and the last `generate` to run wins.

## Exit status

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | An error, or a failed `check`. |
| `130` | `watch` or `build --watch` stopped on `SIGINT`. |
| `143` | `watch` or `build --watch` stopped on `SIGTERM`. |

`build` exits with the compiler's own code when the check finds errors, and with `1` for any other error.

`exec` returns the child command's own exit code. If the child was killed by a
signal instead, `golem` re-raises that signal on itself, so the shell
sees the same signal exit (`130` for `SIGINT`, `143` for `SIGTERM`).

## Examples

```sh
npx golem generate
npx golem check
npx golem watch --config ./frontend/golem.yaml
npx golem exec --watch -- npm run dev
```

`check` is suitable for CI because it leaves generated files, the inventory
and their modification times untouched. Use `exec` to start your app only
after the first successful generation.

## Runtime and imports

The CLI requires Node.js 22.15 or newer. Generated application code needs the
ESM and `NodeNext` settings in [run compiled code](/guide/install#run-compiled-code).
The `./ttsc-plugin` subpath is CommonJS.
