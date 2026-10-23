# CLI

Look up every command, option and exit code.

The `golem` command comes from `@exprtlabs/golem`. Run it from the directory that contains `golem.yaml`. It reads the configuration, runs the configured generators, and writes their files to the configured destinations.

`golem build` compiles your project and rewrites the calls that a build host rewrites ([Build your app](/guide/build)).

A job replaces only files that Golem generated. Another file at an output path stops `generate` and `check` ([files Golem owns](/guide/watch#files-golem-owns)).

```text
Usage: golem <generate|check|watch|exec> [--config golem.yaml]
       golem exec [--watch] -- <command> [args...]
       golem build [--config golem.yaml] [-p tsconfig.build.json] [--watch] [tsc arguments...]
```

`golem` with no arguments, `--help` or `-h` prints the usage and exits.

Commands that need TypeScript use the one installed in the directory of the tsconfig that `golem.yaml` names, or in a parent directory. They do so wherever you run them. Set `GOLEM_TYPESCRIPT_ROOT` to a directory to use the TypeScript installed there instead.

## Commands

| Command | What it does |
| --- | --- |
| `generate` | Writes all outputs |
| `check` | Compares the expected files with the files on disk and writes nothing |
| `watch` | Generates once, then generates again when an input changes |
| `exec -- <command> [args...]` | Generates once, then runs the child command |
| `exec --watch -- <command> [args...]` | Runs the child command and keeps the generator watching |
| `build [--config golem.yaml] [-p tsconfig.build.json] [--watch] [tsc arguments...]` | Generates, type-checks your sources, then emits JavaScript with the generic serde calls rewritten |

`generate` skips a job when its inputs and options did not change since its last run and its outputs exist. A file whose new content is identical keeps its modification time.

`check` generates the expected files in memory. It fails when a file is missing, stale or in conflict, or when a file of a removed job remains. It reports every `parse<T>()` call that no host can rewrite, with its file, its line and what to run. It checks that the Nest codecs agree with the generated registry. With no earlier `generate` or `build`, it stops with one message that tells you to run one of them first.

`watch` runs the affected jobs again when a configuration, API, model, TypeScript or manifest input changes.

`exec` starts the child command after generation succeeds, and forwards its exit status and signals. With `--watch`, the generator keeps watching until the child exits.

`generate` runs the configured jobs in the order set by [configuration](/reference/config). `exec` needs the `--` separator. Arguments after it go to the child process unchanged. `--watch` is valid only with `exec`. An unknown option fails before generation starts.

## Build

`golem build` rewrites the generic serde calls (`parse<T>()`, `stringify<T>()` and the others) while it compiles. It generates the code that `golem.yaml` configures first, so a checkout with no generated files builds in one command. A bundler or Node can apply the same rewrite when it loads your TypeScript ([Build your app](/guide/build)).

```sh
npx golem build
npx golem build --config packages/api/golem.yaml
npx golem build -p tsconfig.build.json
npx golem build --watch
npx golem build --declaration --noEmitOnError
```

A build runs three steps:

1. It generates the outputs of `golem.yaml`, as `golem generate` does. A job whose inputs, options and generator package are unchanged is skipped, so a second build with no change runs no job. An input change runs the job and each later job that reads its outputs.
2. It type-checks the sources you wrote with the TypeScript in your project ([supported versions](/compatibility#supported-versions)). It prints the messages of the compiler unchanged. An error points at your line. The declarations come from your sources, and their import paths change as in [import paths](#import-paths).
3. It emits JavaScript with the calls rewritten and the import paths that Node loads ([import paths](#import-paths)). Source maps point at your sources.

The build starts from `golem.yaml`: the one in the working directory, or the one that `--config` names. Without one it stops with `golem build needs a golem.yaml; run it next to one or pass --config`. It never searches the folders above. It builds the tsconfig that `golem.yaml` names with [`tsconfig`](/reference/config#root-keys), which is the `tsconfig.json` beside `golem.yaml` by default. So `golem generate` and `golem build` always agree on the project.

`-p` names another build config of the same project, such as `tsconfig.build.json` without your tests. It takes a file, or a directory that holds `tsconfig.json`. It must lie in the directory of the tsconfig that `golem.yaml` names. With `--watch` the build repeats when a source, a tsconfig or `golem.yaml` changes. It generates first, so editing a model source regenerates its file and rebuilds once. The models job reads every source of the project, so editing any other source runs it again before the rebuild. A job that reads no changed input does not run. Deleting `outDir` while the build runs starts one build that writes it again.

A build never edits your source files. It writes the generated files that `golem.yaml` configures, and the declarations and JavaScript that the tsconfig asks for into `outDir`. Ignore the generated files and `.golem/` ([ignore generated files](/reference/generated-files#gitignore)). Delete `outDir`, or `declarationDir` when you set one, and the next build writes it again.

### Import paths

Node needs the full file name in an import. So the JavaScript and the declarations that `golem build` writes use full names, and your sources can keep the short form that the compiler accepts. The build changes these specifiers:

- A relative specifier: `./x`, `./dir`, `./dir/`, `.`, `..` and `./x.ts`. They become `./x.js`, `./dir/index.js`, `./dir/index.js`, `./index.js`, `../index.js` and `./x.js`. The extension follows the output file, so a `.mts` source gives `.mjs`.
- A specifier that matches a pattern of `paths`. It becomes a relative path with the extension of the output file.
- A deep path of a package whose root `package.json` has no `exports` field, such as `@nestjs/core/helpers/execution-context-host`. It gets `.js`, or `/index.js` for a folder.

Static `import`, `export … from`, `import()` and an import type (`import("./x").T`) with a string literal change. An import that already ends in `.js` stays as it is.

Every other specifier stays: a bare package name, a `#` import, a URL, a specifier with `?` or `#`, and a specifier that only `baseUrl` resolves. A `paths` alias to a file that is not a source, such as a `.css` file, also stays.

### Compiler arguments

`golem build` takes `--config`, `-p` or `--project`, and `--watch` or `-w`. It passes every other argument unchanged to both compiler runs, the check and the emit, so `tsc` decides what it means. `--declaration`, `--noEmitOnError`, `--listFiles` and `--generateTrace` work as they do for `tsc -p`. The build asks the compiler how the arguments change `declaration` and `noEmitOnError`, so a forwarded `--declaration` writes the declarations from your sources.

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
| `--rootDir`, `--baseUrl`, `--composite`, `--outFile`, `--declarationDir`, `--sourceRoot`, `--mapRoot`, `--inlineSourceMap`, `--inlineSources` | An argument beats the tsconfig that the emit run reads. These change how the build maps your sources and writes declarations and maps | Set it in the tsconfig |

### Type errors

Generation stops only on a type error in the model sources of the models job and in the generated files it writes. A codec built from a model that does not type-check could validate wrongly. A type error in any other file does not stop generation. The check run reports it, as `tsc` does.

Like `tsc`, the build emits JavaScript after a failed check unless `noEmitOnError` is true, in the tsconfig or as `--noEmitOnError`. With it, a type error stops the build before any file is emitted. The exit status is the status of the check whenever it failed.

### What the tsconfig needs

- `outDir` is set. Without it the build stops with `golem build requires compilerOptions.outDir in <tsconfig>: it emits the rewritten sources there.`
- The tsconfig includes at least one file and describes one project. A solution tsconfig that only lists `references` stops the build, and `-b` and `--build` stop it with `golem build does not support project references (-b); run golem build -p <tsconfig> per project.` Run `golem build -p <tsconfig>` for each project, in dependency order.
- Every source file the tsconfig includes builds, inside the directory of the tsconfig or outside it, such as `../shared/*.ts`. The output under `outDir` has the layout that `tsc` emits. As with `tsc`, a `rootDir` must contain every included file. A tsconfig that includes `../shared` sets `rootDir` to a common parent such as `..`.
- The tsconfig emits one file for each source. `outFile` stops the build with `golem build does not support outFile (<tsconfig>).` Emit per file, then bundle with esbuild or Vite and the golem plugin.
- The tsconfig names one directory tree. `rootDirs` stops the build with a message of the same form. Merge the directories, or build each package separately.
- Set `sourceMap` for source maps. `inlineSourceMap` and `sourceRoot` stop the build with a message of the same form, because the build writes its own map files.
- `extends` may name a file anywhere. `paths` and `baseUrl` targets under the directory work as they do for `tsc`.
- `golem build --watch` or `-w` watches. The `tsc --watch` file watcher does not start.

The directory of the tsconfig is the project root. The build covers every file that the tsconfig includes. For a parent tsconfig that includes several packages, put `golem.yaml` in a package and point `tsconfig` at the parent, as in `tsconfig: ../../tsconfig.json`. The build adds the Nest codec decorators to every file of the project when `golem.yaml` has a `controllers` job. A `golem.yaml` with no tsconfig file, such as one with only `openapi` jobs, has nothing to build.

One `golem.yaml` serves one tsconfig. `generate`, `check` and `build` stop in these cases:

| Case | Message | What to do |
| --- | --- | --- |
| The `root` of a `models` or `controllers` job lies outside the directory of the tsconfig | `job root <root> is outside <directory>; use one golem.yaml per tsconfig.` | Give each package that has its own tsconfig its own `golem.yaml`. |
| The `output` of the `models` job lies outside that directory | `Job <id>: output <path> is outside the tsconfig directory <directory>. Move it inside.` | Move the output inside. |
| The tsconfig that `golem.yaml` names differs from the nearest `tsconfig.json` above the `root` of a `models` or `controllers` job | The message names both files. | Name the file the job finds in `tsconfig`, or move the job. |

The model and controller analysis reads the nearest `tsconfig.json` from the job root upward. That is why the files must agree. The `output` of any other job, such as an `openapi` SDK, may lie anywhere.

## Exit status

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | An error, or a failed `check`. |
| `130` | `watch` or `build --watch` stopped on `SIGINT`. |
| `143` | `watch` or `build --watch` stopped on `SIGTERM`. |

`build` exits with the code of the compiler when the check finds errors, and with `1` for any other error.

A `golem.yaml` or an OpenAPI input that is not valid YAML fails the run with a message that starts with `<file>:<line>:<column>`, then the parse error. The file is relative to the working directory. `watch` and `build --watch` report it and run again when the file changes.

`exec` returns the exit code of the child command. If a signal killed the child, `golem` raises that signal on itself, so the shell sees the same signal exit (`130` for `SIGINT`, `143` for `SIGTERM`).

## Examples

```sh
npx golem generate
npx golem check
npx golem watch --config ./frontend/golem.yaml
npx golem exec --watch -- npm run dev
```

`check` suits CI because it leaves generated files and their modification times untouched. Run `golem build` or `golem generate` first. Use `exec` to start your app after the first successful generation.

## Runtime and imports

The CLI runs on the [supported Node.js versions](/compatibility#supported-versions). Generated code needs the [project settings](/guide/install#project-settings), and the serde calls need a [build host](/guide/build).
