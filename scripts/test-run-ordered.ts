import fs from 'node:fs';
import path from 'node:path';
import { run as runNodeTests } from 'node:test';
import { spec, tap } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import testFileTimings from './test-file-timings.js';
import { stepResultFile } from './test-runner/run-state.js';

/** What `test-tier` hands over: the files in start order, and the flags for each file's own process. */
export interface OrderedRun { readonly tier: string; readonly label: string; readonly concurrency: number; readonly execArgv: readonly string[]; readonly files: readonly string[] }

/**
 * `node --test` sorts its files by path, and only `run({ files })` of `node:test` starts them in the given order. This runs
 * it with the reporters, destinations and exit status that the `node --test` command line gave a step before:
 * spec on stdout, TAP and the test-file reporter in the results directory, and exit code 1 when a test fails.
 */
export function runOrdered({ tier, label, concurrency, execArgv, files }: OrderedRun, resultsDir: string | undefined): void {
  runNodeTests({
    files: [...files],
    concurrency,
    execArgv: [...execArgv],
    setup: source => {
      source.compose(new spec()).pipe(process.stdout);
      if (!resultsDir) return;
      source.compose(tap).pipe(fs.createWriteStream(stepResultFile(resultsDir, tier, label, 'tap'), { flush: true }));
      source.compose(testFileTimings).pipe(fs.createWriteStream(stepResultFile(resultsDir, tier, label, 'files.jsonl'), { flush: true }));
    },
  }).on('test:summary', summary => {
    if (!summary.success) process.exitCode = 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runOrdered(JSON.parse(process.argv[2]) as OrderedRun, process.env.FE_DEPS_RESULTS_DIR);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
