# CLI

The `golem` command comes from `@exprtlabs/golem`. Run it from the
directory that contains `golem.yaml`. It resolves the configuration,
runs the configured generators, and writes their artifacts to the configured
destinations. The inventory (`.golem/outputs.json`) records which
generated files each job produced.

`golem build` compiles your project the way `tsc -p` does and rewrites `parse<T>()` on the way. `golem generate` writes the generated code that your editor and your bundler need. It does not scan or rewrite your calls.

A job replaces a file at one of its output paths only when the inventory
records it or the file starts with that generator's marker comment. Any other
file there stops `generate` and `check` with an error naming it; remove or
rename the file, or change the job's output path.

```text
Usage: golem <generate|check|watch|exec> [--config golem.yaml]
       golem exec [--watch] -- <command> [args...]
       golem build [--config golem.yaml] [-p tsconfig.build.json] [--watch] [tsc arguments...]
       golem --help
```

Running `golem` with no arguments, or with `--help` or `-h`, prints
usage and exits.

Commands that need TypeScript use the one installed in the directory of the tsconfig the `golem.yaml` names (or in a parent directory), wherever you run them from; set `GOLEM_TYPESCRIPT_ROOT` to a directory to use the TypeScript installed there instead.

## Commands

| Command | What it does |
| --- | --- |
| `generate` | Writes all outputs and the inventory. A job whose inputs and options did not change since its last run, and whose outputs exist, is skipped. |
| `check` | Generates the expected artifact set in memory and fails when files are missing, stale, conflicting or obsolete inventoried outputs remain. It reports every `parse<T>()` call that no host can rewrite, with its file, its line and what to run, and checks that the Nest codecs agree with the generated registry. It does not write files. |
| `watch` | Generates once, then reruns affected jobs when observed configuration, API, model, TypeScript or manifest inputs change. |
| `exec -- <command> [args...]` | Generates once, starts the child command only after generation succeeds, and forwards its exit status and signals. |
| `exec --watch -- <command> [args...]` | Does the same and keeps the generator watching until the child exits. |
| `build [--config golem.yaml] [-p tsconfig.build.json] [--watch] [tsc arguments...]` | Generates, type-checks your TypeScript sources, then emits JavaScript with the generic serde calls rewritten. |

`generate` runs configured jobs in the order set by
[configuration](/reference/config). `exec` requires the `--` separator.
Arguments after it are passed to the child process unchanged. `--watch` is
valid only with `exec`; unknown options fail before generation starts.

## Build

`golem build` rewrites the generic serde calls (`parse<T>()`, `stringify<T>()` and the others) while it compiles. It generates the code `golem.yaml` configures first, so a checkout with no generated files builds in one command. A bundler or Node can apply the same rewrite while it loads your TypeScript instead: use the [Vite plugin](/reference/runtime-api#vite), the [esbuild plugin](/reference/runtime-api#esbuild) or the [Node loader](/reference/runtime-api#loader). Each of them opens your project from `golem.yaml`, and scans each file itself.

```sh
npx golem build
npx golem build --config packages/api/golem.yaml
npx golem build -p tsconfig.build.json
npx golem build --watch
npx golem build --declaration --noEmitOnError
```

A build runs three steps:

1. It generates the outputs of `golem.yaml`, as `golem generate` does. A job whose inputs did not change since the last run is skipped: `.golem/jobs.json` keeps, per job, a hash of the code of golem and of the job's generator package, the job's options and a hash of every input it read, so a second build with no change runs no job. A job whose generator code changed runs again, even under the same version. An input change runs the job and every job after it that reads its outputs.
2. It type-checks the sources you wrote with the TypeScript in your project, TypeScript 6.0 or 7, and prints its messages unchanged. An error points at your line, and the declarations come from your sources.
3. It emits JavaScript with the calls rewritten and the import paths that Node loads ([import paths](#import-paths)). Source maps point at your sources.

The build starts from `golem.yaml`: the one in the working directory, or the one `--config` names. Without one it stops with `golem build needs a golem.yaml; run it next to one or pass --config`, and it never searches the folders above. It builds the tsconfig that `golem.yaml` names with [`tsconfig`](/reference/config#root-keys), which is the `tsconfig.json` beside `golem.yaml` by default, so `golem generate` and `golem build` always agree on the project.

`-p` names another build config of the same project, such as `tsconfig.build.json` without your tests. It takes a file, or a directory that holds `tsconfig.json`, and it must lie in the directory of the tsconfig that `golem.yaml` names; any other location is an error. With `--watch` the build repeats when a source, tsconfig or `golem.yaml` changes: it generates first, so editing a model source regenerates its file and rebuilds once. The models job reads every source of the project, so editing any other source runs it again before the rebuild. A job that reads no changed input, such as a generator that reads only the models, does not run. Deleting `outDir` while it runs starts one build that writes it again.

A build never edits your source files. It writes the generated files `golem.yaml` configures, the declarations and JavaScript the tsconfig asks for into `outDir`, and its own files into `.golem/`: per tsconfig under `.golem/build/<tsconfig name>/`, the incremental state and a copy of your sources with the calls rewritten and the import paths changed. Two tsconfig files in one directory never share that state. Always ignore `.golem/build/` and `.golem/jobs.json`. Ignore the generated files and the rest of `.golem/` together, or commit the generated files with `.golem/outputs.json` and `.golem/codec-keys.json` ([what to commit](/reference/generated-files#gitignore)). Delete `outDir`, or `declarationDir` when you set one, and the next build writes it again.

### Import paths

Node needs the full file name in an import. So the JavaScript that `golem build` writes uses full names, and your sources can keep the short form the compiler accepts. The build changes these specifiers:

- A relative specifier: `./x`, `./dir`, `./dir/`, `.`, `..` and `./x.ts`. They become `./x.js`, `./dir/index.js`, `./dir/index.js`, `./index.js`, `../index.js` and `./x.js`.
- A specifier that matches a pattern of `paths`. It becomes a relative path with the extension of the output file.
- A deep path of a package whose root `package.json` has no `exports` field, such as `@nestjs/core/helpers/execution-context-host`. It gets `.js`, or `/index.js` for a folder.

Static `import`, `export … from` and `import()` with a string literal change. An import that already ends in `.js` stays as it is.

Every other specifier stays: a bare package name, a `#` import, a URL, a specifier with `?` or `#`, and a specifier that only `baseUrl` resolves. A `paths` alias to a file that is not a source, such as a `.css` file, also stays, and Node cannot load it.

The build changes only the copy of your sources under `.golem/build/`, so your source files stay as you wrote them.

### Compiler arguments

`golem build` takes `--config`, `-p` or `--project`, and `--watch` or `-w` (`-w` also stops the compiler's own watcher from starting). It passes every other argument unchanged to both compiler runs, the check and the emit, so `tsc` decides what it means: `--declaration`, `--noEmitOnError`, `--listFiles` and `--generateTrace` work as they do for `tsc -p`. The build asks the compiler how the arguments change `declaration` and `noEmitOnError`, so a forwarded `--declaration` writes the declarations from your sources.

The build sets some arguments itself. Passing one stops the build with `golem build sets <argument> itself (<reason>); <workaround>`.

| Argument | Why the build sets it | Instead |
| --- | --- | --- |
| `--noCheck` | The emit run skips the check and the check run reports the errors | A failed check still emits unless `noEmitOnError` is set |
| `--noEmit` | The check run writes nothing and the emit run writes the JavaScript | Set `noEmit` in the tsconfig |
| `--emitDeclarationOnly` | The check run writes the declarations and the emit run writes the JavaScript | Set `emitDeclarationOnly` in the tsconfig |
| `--tsBuildInfoFile` | Each run keeps its own incremental state | Delete `.golem/build` to start clean |
| `--incremental` | Both runs are incremental | Delete `.golem/build` to build everything again |
| `--outDir` | The emit run writes into the `outDir` of the tsconfig | Set `outDir` in the tsconfig, or pass `-p` a tsconfig that extends it and sets another `outDir` |
| `--listEmittedFiles` | The build reads the list to point source maps at your sources | List the files in `outDir` after the build |
| `--rootDir`, `--baseUrl`, `--composite`, `--outFile`, `--declarationDir`, `--sourceRoot`, `--mapRoot`, `--inlineSourceMap`, `--inlineSources` | An argument beats the tsconfig the emit run reads, and these change how the build maps your sources onto its copy and writes declarations and maps | Set it in the tsconfig |

### Type errors

Generation stops only on a type error in the models job's own model sources and in the generated files it writes, because a codec built from a model that does not type-check could validate wrongly. A type error in any other file does not stop generation; the check run reports it, as `tsc` does.

Like `tsc`, the build emits JavaScript after a failed check unless `noEmitOnError` is true, in the tsconfig or as `--noEmitOnError`. With it, a type error stops the build before any file is emitted. The exit status is the check's whenever it failed.

### What the tsconfig needs

- `outDir` is required.
- Every source file the tsconfig includes builds, inside the tsconfig's directory or outside it, such as `../shared/*.ts`. The output under `outDir` has the layout `tsc` emits. As with `tsc`, a `rootDir` must contain every included file, so a tsconfig that includes `../shared` sets `rootDir` to a common parent such as `..`.
- `extends` may name a file anywhere. `paths` and `baseUrl` targets under the directory work as they do for `tsc`.

Some configurations are not supported. `-b` and `--build` are rejected with `golem build does not support project references (-b); run golem build -p <tsconfig> per project.`

| Not supported | Why | Workaround |
| --- | --- | --- |
| `-b` and project references | One copy of the sources for each project | Run `golem build -p <tsconfig>` per project, in dependency order |
| `outFile` | The emit run writes one file per source | Emit per file, then bundle with esbuild or Vite and the golem plugin |
| `rootDirs` | The copy mirrors one directory tree | Merge the directories, or build each package separately |
| `inlineSourceMap`, `sourceRoot` | The build writes its own map files | Use `sourceMap` |
| The `tsc --watch` file watcher | The build runs two compiles per cycle | Use `golem build --watch`, which polls |

The tsconfig's directory is the project root. The build covers every file the tsconfig includes, so a parent tsconfig that includes several packages builds all of them: put `golem.yaml` in a package and point `tsconfig` at the parent, as in `tsconfig: ../../tsconfig.json`. The Nest codec decorators are added to every file of the project when `golem.yaml` has a `controllers` job. A `golem.yaml` with no tsconfig file, such as one with only `openapi` jobs, has nothing to build.

One `golem.yaml` serves one tsconfig. `generate`, `check` and `build` fail on a `models` or `controllers` job whose `root` lies outside the tsconfig's directory: `job root <root> is outside <directory>; use one golem.yaml per tsconfig.` Put each package that has its own tsconfig in its own `golem.yaml`. Output paths of any job, including `openapi`, may lie anywhere. They also fail when the tsconfig that `golem.yaml` names differs from the nearest `tsconfig.json` from the job's `root` upward, because the model and controller analysis reads that nearest file. The error names both files and says that a tsconfig that differs from the job's own is not supported yet. Name the file the job finds, or move the job.

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
