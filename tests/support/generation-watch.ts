import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { type TestContext } from 'node:test';
import { watchPipeline } from '#golem/cli';
import type { WatchOptions } from '#golem/watch';
import { resolveTypeScript } from '#golem/typescript-version';
import { workspace } from './process.js';
import { writeFixture } from './consumer.js';

// Tests that count the TypeScript 7 compiler's server processes and sessions, which TypeScript 6 does not have, skip on this.
export const skipOnTypeScript6 = resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? process.cwd()).major === 6
  && 'TypeScript 6 runs no compiler server process';

/** A generation project in a temp directory: a model, an OpenAPI document and a golem.yaml that runs both, with the golem packages linked. */
export function generationWatchFixture(t: TestContext): { root: string; config: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-watch-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/@exprtlabs'), { recursive: true });
  for (const name of ['golem', 'golem-model', 'golem-openapi']) {
    fs.symlinkSync(path.join(workspace, 'packages', name), path.join(root, 'node_modules/@exprtlabs', name), 'dir');
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"watch-fixture","type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  const config = path.join(root, 'golem.yaml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(
    'validation: true\n',
    'validation: true\nallowAny: false\n',
  ));
  return { root, config };
}

/** Counts the good runs of a watch: pass `onRun` to `watchPipeline`; `lines` holds the line of each run, in order. */
export function countRuns(): (() => number) & { readonly lines: string[]; readonly onRun: (line: string) => void } {
  const lines: string[] = [];
  return Object.assign(() => lines.length, { lines, onRun: (line: string): void => { lines.push(line); } });
}

/** Starts `watchPipeline` on `config`. `runs` counts its good runs, `errors` holds what it reported and `context()` prints them for a timeout message; `stop()` ends the watch. */
export function startGenerationWatch(config: string, options: Omit<WatchOptions, 'onRun'> = {}): {
  readonly runs: ReturnType<typeof countRuns>;
  readonly errors: unknown[];
  readonly context: () => string;
  readonly stop: () => void;
} {
  const runs = countRuns();
  const errors: unknown[] = [];
  const stop = watchPipeline(config, error => { errors.push(error); }, { ...options, onRun: runs.onRun });
  return { runs, errors, context: () => `(errors=${errors.map(String).join('; ')})`, stop };
}

export function compilerChildren(parent: number): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null && Number(match[2]) === parent && match[3].includes('--api'))
    .map(match => Number(match[1]));
}
