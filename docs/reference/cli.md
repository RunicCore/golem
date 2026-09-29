# CLI

The `runic-codegen` command comes from `@exprtlabs/codegen`. Run it from the
directory that contains `runic-codegen.yaml`. It resolves the configuration,
runs the configured generators, and writes their artifacts to the configured
destinations. The inventory (`.runic-codegen/outputs.json`) records which
generated files each job produced.

```text
Usage: runic-codegen <generate|check|watch|exec> [--config runic-codegen.yaml]
       runic-codegen exec [--watch] -- <command> [args...]
       runic-codegen --help
```

Running `runic-codegen` with no arguments, or with `--help` or `-h`, prints
usage and exits.

## Commands

| Command | What it does |
| --- | --- |
| `generate` | Writes all outputs and the inventory. |
| `check` | Generates the expected artifact set in memory and fails when files are missing, stale, conflicting or obsolete inventoried outputs remain. It does not write files. |
| `watch` | Generates once, then reruns affected jobs when observed configuration, API, model, TypeScript or manifest inputs change. |
| `exec -- <command> [args...]` | Generates once, starts the child command only after generation succeeds, and forwards its exit status and signals. |
| `exec --watch -- <command> [args...]` | Does the same and keeps the generator watching until the child exits. |

`generate` runs configured jobs in the order set by
[configuration](/reference/config). `exec` requires the `--` separator.
Arguments after it are passed to the child process unchanged. `--watch` is
valid only with `exec`; unknown options fail before generation starts.

## Exit status

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | An error, or a failed `check`. |
| `130` | `watch` stopped on `SIGINT`. |
| `143` | `watch` stopped on `SIGTERM`. |

`exec` returns the child command's own exit code. If the child was killed by a
signal instead, `runic-codegen` re-raises that signal on itself, so the shell
sees the same signal exit (`130` for `SIGINT`, `143` for `SIGTERM`).

## Examples

```sh
npx runic-codegen generate
npx runic-codegen check
npx runic-codegen watch --config ./frontend/runic-codegen.yaml
npx runic-codegen exec --watch -- npm run dev
```

`check` is suitable for CI because it leaves generated files, the inventory
and their modification times untouched. Use `exec` to start your app only
after the first successful generation.

## Runtime and imports

The CLI requires Node.js 22.12 or newer. Generated application code needs the
ESM and `NodeNext` settings in [run compiled code](/guide/install#run-compiled-code).
The `./ttsc-plugin` subpath is CommonJS.
