# CLI

Look up every command, option and exit code.

The `golem` command comes from `@exprtlabs/golem`. Run it from the directory that contains `golem.yaml`. It reads the configuration, runs the configured generators, and writes their files to the configured destinations.

`golem build` compiles your project and rewrites the calls that a build tool rewrites ([Build tools](/guide/build)).

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

### Generate and check

`generate` runs the configured jobs in the order set by [configuration](/reference/config). It skips a job when its inputs and options did not change since its last run and its outputs exist. A file whose new content is identical keeps its modification time.

`check` generates the expected files in memory and writes nothing. It fails in these cases:

- A file is missing, stale or in conflict.
- A file of a removed job remains.

`check` also does these things:

- It reports every `parse<T>()` call that no build tool can rewrite, with its file, its line and what to run.
- It checks that the Nest codecs agree with the generated registry.
- With no earlier `generate` or `build`, it stops with one message. The message tells you to run one of them first.

### Watch

`watch` runs the affected jobs again when a configuration, API, model, TypeScript or manifest input changes.

`watch` and `build --watch` wait for file-system events from the operating system:

- They do not poll, so an idle watch reads no file and uses no CPU.
- An event wakes the watch after 50 ms. The watch then compares the inputs with what the last run left, so a burst of saves starts one run.
- A package manager's install starts a full run. This is a change to `.package-lock.json`, `.modules.yaml`, `.yarn-state.yml` or `.yarn-integrity` in the `node_modules` folder of the tsconfig's folder or of a folder above it.
- Files inside `node_modules` are not watched. The exception is a workspace package that a link in `node_modules` leads to.

When the system cannot watch a folder:

- The cause can be a lack of inotify watches (raise `fs.inotify.max_user_watches`) or of open files. The watch reports it once with the fix and goes on without that folder.
- When it can watch no folder at all, the watch reports that and stops. It exits with code `1`. `build --watch` exits with `1` too.
- Inside a Docker bind mount, a host edit, a new file, a saved file and a deleted folder start a run. A deleted file alone does not. The watch notices that delete at the next save of a watched file.

Each good run of `watch` prints one line: the result of each job, then the time of the run.

```text
openapi:sdk: unchanged · model: 2 files updated · 412 ms
```

- A job shows the files it updated or removed.
- A job that did not run, or wrote nothing new, shows `unchanged`.
- The first good run after a failed run starts with `Recovered:`.
- `exec --watch` prints the same line for its first run.
- A failed run prints its error.
- When a job fails before it writes, the run also says that the job wrote no files and that its last good output stays in place. A job that finished earlier in the same run has written its files.
- When a job writes its files and then cannot save its record in `.golem/`, the run says that the job wrote its files but could not save its record.

### Exec

- `exec` starts the child command after generation succeeds. It forwards the exit status and the signals of the child.
- With `--watch`, the generator keeps watching until the child exits.
- `exec` needs the `--` separator. Arguments after it go to the child process unchanged.
- `--watch` is valid only with `exec` and `build`.
- An unknown option fails before generation starts.

## Build

`golem build` rewrites the generic serde calls (`parse<T>()`, `stringify<T>()` and the others) while it compiles. It generates the code that `golem.yaml` configures first, so a checkout with no generated files builds in one command. A bundler or Node can apply the same rewrite when it loads your TypeScript ([Build tools](/guide/build)).

```sh
npx golem build
npx golem build --config packages/api/golem.yaml
npx golem build -p tsconfig.build.json
npx golem build --watch
npx golem build --declaration --noEmitOnError
```

A build runs three steps:

1. It generates the outputs of `golem.yaml`, as `golem generate` does. A job is skipped when its inputs, its options and its generator code are unchanged. The generator code is the set of files that the run loaded from the generator package, each compared by its content. A file that the run did not load does not change it, and a file that changed or is gone does. A second build with no change runs no job. An input change runs the job and each later job that reads its outputs.
2. It type-checks the sources you wrote with the TypeScript in your project ([supported versions](/compatibility#supported-versions)). The check runs inside the `golem` process: the build starts no `tsc`. It prints the diagnostics as `tsc -p` prints them. An error points at your line. The declarations come from your sources, and their import paths change as in [import paths](#import-paths).
3. It emits JavaScript with the calls rewritten and the import paths that Node loads ([import paths](#import-paths)), also in memory. Source maps point at your sources. It writes each output file only when the file differs from the file on disk.

The check and the emit are two programs of one compiler. The messages of [compiler arguments](#compiler-arguments) call them the check program and the emit program.

The build starts from `golem.yaml`:

- It uses the `golem.yaml` in the working directory, or the one that `--config` names.
- Without one it stops with `golem build needs a golem.yaml; run it next to one or pass --config`. It never searches the folders above.
- It builds the tsconfig that `golem.yaml` names with [`tsconfig`](/reference/config#root-keys). The default is the `tsconfig.json` beside `golem.yaml`.
- So `golem generate` and `golem build` always agree on the project.

Rules of `-p`:

- `-p` names another build config of the same project, such as `tsconfig.build.json` without your tests.
- It takes a file, or a directory that holds `tsconfig.json`.
- It must lie in the directory of the tsconfig that `golem.yaml` names.

Rules of `--watch`:

- The build repeats when a source, a tsconfig or `golem.yaml` changes.
- The build generates first, so editing a model source regenerates its file and rebuilds once.
- The models job reads every source of the project, so editing any other source runs it again before the rebuild. A job that reads no changed input does not run.
- Deleting `outDir` while the build watches starts one build that writes it again.
- When you delete a source, the build removes the JavaScript, declaration and map files that it emitted for that source from `outDir` and `declarationDir`. It also removes the folders that become empty. It removes no file that it did not write.

A build never edits your source files:

- It writes the generated files that `golem.yaml` configures.
- It writes the declarations and JavaScript that the tsconfig asks for into `outDir`.
- It writes an output only when its text differs from the file on disk. A file that is current keeps its time stamp, and a file that another tool changed is written again.
- It writes an existing output in place, so a link stays a link and the file mode stays.
- It writes no file until the emit has succeeded. A failed emit leaves the outputs of the build before as they were.
- Ignore the generated files and `.golem/` ([ignore generated files](/reference/generated-files#gitignore)).
- Delete `outDir`, or `declarationDir` when you set one, and the next build writes it again.

### Import paths

Node needs the full file name in an import. So the JavaScript and the declarations that `golem build` writes use full names, and your sources can keep the short form that the compiler accepts. The build changes these specifiers:

- A relative specifier: `./x`, `./dir`, `./dir/`, `.`, `..` and `./x.ts`. They become `./x.js`, `./dir/index.js`, `./dir/index.js`, `./index.js`, `../index.js` and `./x.js`. The extension follows the output file, so a `.mts` source gives `.mjs`.
- A specifier that matches a pattern of `paths`. It becomes a relative path with the extension of the output file.
- A deep path of a package whose root `package.json` has no `exports` field, such as `@nestjs/core/helpers/execution-context-host`. It gets `.js`, or `/index.js` for a folder.

Static `import`, `export … from`, `import()` and an import type (`import("./x").T`) with a string literal change. An import that already ends in `.js` stays as it is.

Every other specifier stays: a bare package name, a `#` import, a URL, a specifier with `?` or `#`, and a specifier that only `baseUrl` resolves. A `paths` alias to a file that is not a source, such as a `.css` file, also stays.

### Compiler arguments

- `golem build` takes `--config`, `-p` or `--project`, and `--watch` or `-w`.
- It passes every other argument unchanged to the check program and the emit program, so `tsc` decides what it means.
- `--declaration` and `--noEmitOnError` work as they do for `tsc -p`. The build asks the compiler how the arguments change `declaration` and `noEmitOnError`, so a forwarded `--declaration` writes the declarations from your sources.
- `--listFiles` prints the files of the program after the diagnostics, as `tsc -p` does.
- A file name among the arguments stops the build with a message that starts `The compiler arguments name source files (...)` and holds `TS5042`. `tsc -p` refuses it too: a build names its files in the tsconfig.

The build sets some arguments itself. Passing one stops the build with `golem build sets <argument> itself (<reason>); <workaround>`.

| Argument | Why the build sets it | Instead |
| --- | --- | --- |
| `--noCheck` | The emit program skips the type check and the check program reports the errors | A build emits JavaScript when the check fails unless `noEmitOnError` is set |
| `--noEmit` | The check program writes no JavaScript and the emit program writes it | Set `noEmit` in the tsconfig to check without emitting |
| `--emitDeclarationOnly` | The check program writes the declarations from your sources and the emit program writes the JavaScript | Set `emitDeclarationOnly` in the tsconfig for a declarations-only build |
| `--tsBuildInfoFile`, `--incremental` | Golem keeps no TypeScript build state: it compares each output with the file on disk | Leave it out. A build with nothing changed writes no file |
| `--outDir` | The emit program writes into the `outDir` of the tsconfig | Set `outDir` in the tsconfig, or pass `-p` a tsconfig that extends it and sets another `outDir` |
| `--listEmittedFiles` | Golem writes the outputs itself and prints no list of them | List the files in `outDir` after the build |
| `--baseUrl` | Golem reads the `baseUrl` and `paths` of the tsconfig to give each import the path Node loads | Set it in `tsconfig.json` |
| `--composite` | The emit program is not a composite build, and the check program must report what it reports | Set it in `tsconfig.json` |
| `--outFile` | TypeScript 7 removed `outFile` and TypeScript 6 deprecates it, so one build cannot write the same files on both | Emit one file for each source, then bundle with [esbuild](/guide/build#esbuild) or [Vite](/guide/build#vite) and the golem plugin |
| `--declarationDir` | The check program writes the declarations from your sources into the directory of the tsconfig | Set it in `tsconfig.json` |

The build refuses two more kinds of option. It refuses them before it generates anything, whether the tsconfig sets them or a flag does:

| Option | Refused because | Message |
| --- | --- | --- |
| `--generateTrace`, `--extendedDiagnostics`, `--explainFiles`, `--traceResolution`, `--diagnostics` | They measure the `tsc` process or give facts that the build does not have | `golem build does not support <option> (<tsconfig>): it measures the tsc process. Run tsc -p <tsconfig> --noEmit <flag> to get it.` |
| `--showConfig`, `--listFilesOnly` and other commands of `tsc` | They are commands of `tsc`, not options of a build | `golem build does not support --<command> (<tsconfig>): it is a command of tsc, not an option of a build. Run tsc --<command> instead.` |

Run the `tsc` command that the message names. Give it `--noEmit` when you run `tsc -p`.

`tsc -p <tsconfig>` writes JavaScript with no rewrite into the same `outDir`. That overwrites the output of `golem build`. Run `tsc -p` with `--noEmit` to check only.

### Type errors

Generation stops only on a type error in the model sources of the models job and in the generated files it writes. A codec built from a model that does not type-check could validate wrongly. A type error in any other file does not stop generation. The check run reports it, as `tsc` does.

Like `tsc`, the build emits JavaScript after a failed check unless `noEmitOnError` is true, in the tsconfig or as `--noEmitOnError`. With it, a type error stops the build before any file is written.

- The build prints each diagnostic as `tsc -p` does. It uses the pretty form with colors and a `Found N errors` line when the `pretty` option is true. Without the option it uses that form when stdout is a terminal and `NO_COLOR` is not set.
- When the check fails, the exit status is `1`. It is `2` when the build still wrote the declarations of the project.
- When the emit fails, the build writes no file, prints the compiler messages and exits with `1`.

### Output folders

The compiler decides where each output goes. The build writes every file at the path that `tsc -p` gives it. JavaScript and maps go below `outDir`. Declarations go below `declarationDir`, else `outDir`.

The layout starts at `rootDir`. Without a `rootDir`, it starts at the folder of the tsconfig. Set `rootDir` in the tsconfig, or pass `--rootDir <folder>`. The build forwards the argument to the compiler, as `tsc` takes it.

The build stops before it writes when an output would land outside its folder. This happens when a source lies outside the `rootDir`, or outside the project folder when you set no `rootDir`. The message is `golem build would write <file> outside <folder>, because a source of <tsconfig> is outside its rootDir or, with no rootDir, outside the project folder.` Set `rootDir` to a folder that holds every source.

### What the tsconfig needs

- `outDir` is set. Without it the build stops with `golem build requires compilerOptions.outDir in <tsconfig>: it emits the rewritten sources there.`
- The tsconfig includes at least one file. A solution tsconfig that only lists `references` stops the build. `-b` and `--build` stop it too. The message names each referenced project with its command, `golem build --config <project folder>/golem.yaml`. Run that command for each project, in dependency order.
- A tsconfig with `references` and files builds as `tsc -p` builds it: the compiler reads the declaration files of the referenced projects. Each referenced project sets `composite: true` and is built first. A project that is not built stops the build with the compiler error and the line `<tsconfig> has not been built: <file> has no declaration output. Build it first with golem build --config <project folder>/golem.yaml.` The build writes no file.
- Every source file the tsconfig includes builds, inside the directory of the tsconfig or outside it, such as `../shared/*.ts`. The output under `outDir` has the layout that `tsc` emits. As with `tsc`, a `rootDir` must contain every included file. A tsconfig that includes `../shared` sets `rootDir` to a common parent such as `..`.
- The tsconfig emits one file for each source. `outFile` stops the build with `golem build does not support outFile (<tsconfig>): TypeScript 7 removed it (TS5102) and TypeScript 6 deprecates it (TS5101), so one build cannot write the same files on both. Emit one file for each source, then bundle with esbuild or Vite and the golem plugin.`
  - TypeScript 6 writes one joined file for `outFile`. TypeScript 7 ignores it and writes one file for each source. Golem rewrites and maps each file alone, so a joined file does not fit.
  - To get one file, emit one file for each source, then bundle with [esbuild](/guide/build#esbuild) or [Vite](/guide/build#vite) and the golem plugin.
- `rootDirs` works as it does for `tsc`: the compiler resolves a relative import through the virtual folders. The layout of `outDir` does not change. When the plain relative path does not reach the target, the emitted files do not sit side by side. The build then keeps the specifier as you wrote it, as `tsc` does. A declaration file target also stays as written.
- Set `sourceMap` or `inlineSourceMap` for source maps. A map points at your original sources: a rewritten call maps back to its line and column in your file. `sourceRoot`, `mapRoot` and `inlineSources` work as they do for `tsc`. The build keeps the `sourceRoot`, the `sources` and the `sourceMappingURL` that the compiler wrote, and `inlineSources` embeds your original text. An inline map that the build cannot read stops the build with the file name, and the build writes no file.
- `extends` may name a file anywhere. `paths` and `baseUrl` targets under the directory work as they do for `tsc`.
- `golem build --watch` or `-w` watches. The `tsc --watch` file watcher does not start.

- The directory of the tsconfig is the project root. The build covers every file that the tsconfig includes.
- For a parent tsconfig that includes several packages, put `golem.yaml` in a package and point `tsconfig` at the parent, as in `tsconfig: ../../tsconfig.json`.
- The build adds the Nest codec decorators to every file of the project when the `ts-openapi` block of `golem.yaml` holds the [`nest` extension](/reference/config#nest-extension). A docs job is not needed.
- A `golem.yaml` with no tsconfig file, such as one with only SDK jobs, has nothing to build.

One `golem.yaml` serves one tsconfig. `generate`, `check` and `build` stop in these cases:

| Case | Message | What to do |
| --- | --- | --- |
| A root of the models job or of a docs job lies outside the directory of the tsconfig | `job root <root> is outside <directory>; use one golem.yaml per tsconfig.` | Give each package that has its own tsconfig its own `golem.yaml`. |
| The `output` of the models job, or any output that the app imports, lies outside that directory | `Job <id>: output <path> is outside the tsconfig directory <directory>. Move it inside.` | Move the output inside. |
| The tsconfig that `golem.yaml` names has no files and only `references` | The message names each referenced project. | Name one referenced project in `tsconfig`, such as `tsconfig.app.json`. |

Every job reads the tsconfig that `golem.yaml` names. A tsconfig nearer to a job root is not read. The `output` of any other job, such as an SDK, may lie anywhere.

## Exit status

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | An error, or a failed `check`. |
| `130` | `watch` or `build --watch` stopped on `SIGINT`. |
| `143` | `watch` or `build --watch` stopped on `SIGTERM`. |

`build` exits with `1` when the check fails, with `2` when the check fails and the build still wrote declarations ([type errors](#type-errors)), and with `1` for any other error.

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

The CLI runs on the [supported Node.js versions](/compatibility#supported-versions). Generated code needs the [project settings](/guide/quick-start#project-settings), and the serde calls need a [build tool](/guide/build).
