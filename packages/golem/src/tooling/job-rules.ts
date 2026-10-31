import path from 'node:path';
import { MODEL_BOUNDARY } from './job-facts.js';
import { isInsideDirectory } from './plan-support.js';
import type { JobFacts, JobOutput, JobPlan, JobRuleContext, ProgramView } from './job-facts.js';

/** The rule a config broke. */
export type JobRule = 'cycle' | 'overlap' | 'reserved-output' | 'containment' | 'contract-missing' | 'contract-twice';

/** A config whose jobs break a generic rule of core. It is the developer's input to fix: loading stops and the message names the jobs. */
export class JobRuleError extends Error {
  constructor(readonly rule: JobRule, message: string, readonly jobs: readonly string[]) {
    super(message);
    this.name = 'JobRuleError';
  }
}

function overlaps(a: string, b: string): boolean {
  return isInsideDirectory(a, b) || isInsideDirectory(b, a);
}

/** Whether `reader` reads a file that `writer` writes. */
function readsOutputOf(reader: JobFacts, writer: JobFacts): boolean {
  if (reader === writer) return false;
  return writer.outputs.some(output => (
    reader.inputFiles.some(file => isInsideDirectory(output.path, file))
    || reader.inputFolders.some(folder => overlaps(folder, output.path))
  ));
}

function providersOf(jobs: readonly JobFacts[]): Record<string, string> {
  const providers: Record<string, string> = {};
  for (const job of jobs) {
    for (const contract of job.provides) {
      const previous = providers[contract];
      if (previous !== undefined) {
        throw new JobRuleError('contract-twice', `The contract ${contract} has two providers, ${previous} and ${job.id}. At most one job provides it.`, [previous, job.id]);
      }
      providers[contract] = job.id;
    }
  }
  for (const job of jobs) {
    for (const contract of job.needs) {
      if (providers[contract] === undefined) {
        throw new JobRuleError('contract-missing', `Job ${job.id} needs the contract ${contract}, but no job provides it.`, [job.id]);
      }
    }
  }
  return providers;
}

function checkOutputs(jobs: readonly JobFacts[], context: JobRuleContext): void {
  const owned = path.join(path.dirname(context.configFile), '.golem');
  const outputs = jobs.flatMap(job => job.outputs.map((output): [string, JobOutput] => [job.id, output]));
  for (const [id, output] of outputs) {
    if (overlaps(output.path, context.configFile)) throw new JobRuleError('reserved-output', `Job ${id}: output ${output.path} holds golem.yaml, which golem owns.`, [id]);
    if (overlaps(output.path, owned)) throw new JobRuleError('reserved-output', `Job ${id}: output ${output.path} overlaps the .golem folder, which golem owns.`, [id]);
  }
  for (const [index, [id, output]] of outputs.entries()) {
    for (const [otherId, other] of outputs.slice(index + 1)) {
      if (overlaps(output.path, other.path)) {
        throw new JobRuleError('overlap', `Overlapping outputs: ${output.path} (job ${id}) and ${other.path} (job ${otherId}).`, [...new Set([id, otherId])]);
      }
    }
  }
}

/** F-42: one golem.yaml serves one tsconfig, so a job root and an output the app imports lie inside its directory. */
function checkContainment(jobs: readonly JobFacts[], context: JobRuleContext): void {
  const directory = context.tsconfigDirectory;
  for (const job of jobs) {
    for (const root of job.ownedRoots) {
      if (!isInsideDirectory(directory, root)) throw new JobRuleError('containment', `Job ${job.id}: root ${root} is outside ${directory}; use one golem.yaml per tsconfig.`, [job.id]);
    }
    for (const output of job.outputs) {
      if (output.importedByApp === true && !isInsideDirectory(directory, output.path)) {
        throw new JobRuleError('containment', `Job ${job.id}: output ${output.path} is outside the tsconfig directory ${directory}. Move it inside.`, [job.id]);
      }
    }
  }
}

/** "Before" edges between job indexes: `before[a]` holds the jobs that run after job `a`. */
class Edges {
  readonly before: Set<number>[];

  constructor(count: number) {
    this.before = Array.from({ length: count }, () => new Set<number>());
  }

  add(first: number, second: number): void {
    this.before[first]?.add(second);
  }

  /** Whether a path of edges leads from `from` to `to`. */
  reaches(from: number, to: number): boolean {
    const seen = new Set<number>();
    const stack = [from];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(this.before[next] ?? []));
    }
    return false;
  }

  /** The jobs of one cycle in run order, or none. */
  cycle(): number[] | undefined {
    const state = new Map<number, 'open' | 'done'>();
    const trail: number[] = [];
    const visit = (job: number): number[] | undefined => {
      state.set(job, 'open');
      trail.push(job);
      for (const next of this.before[job] ?? []) {
        if (state.get(next) === 'open') return trail.slice(trail.indexOf(next));
        if (!state.has(next)) {
          const found = visit(next);
          if (found) return found;
        }
      }
      trail.pop();
      state.set(job, 'done');
      return undefined;
    };
    for (let job = 0; job < this.before.length; job += 1) {
      if (!state.has(job)) {
        const found = visit(job);
        if (found) return found;
      }
    }
    return undefined;
  }
}

/**
 * The edges of the generic order rules over `jobs`, in config order.
 *
 * Rule 1: a job runs after the jobs whose output files it reads; a cycle stops loading.
 * Rule 2: for each job J that reads no program and each program reader R, "J before R" is added when no path of edges
 * leads between them in either direction, repeated until no edge applies (an added edge can decide another pair). Only then
 * two program readers with no path either way get one edge in config order, and the path-decided edges run again, so a
 * tie never contradicts a path. No job has to know what the program imports.
 */
function orderEdges(jobs: readonly JobFacts[]): Edges {
  const edges = new Edges(jobs.length);
  for (const [writer, writerJob] of jobs.entries()) {
    for (const [reader, readerJob] of jobs.entries()) {
      if (readsOutputOf(readerJob, writerJob)) edges.add(writer, reader);
    }
  }
  const cycle = edges.cycle();
  if (cycle) {
    const ids = cycle.map(job => jobs[job]?.id ?? '');
    const chain = ids.map((id, index) => `${id} writes what ${ids[(index + 1) % ids.length]} reads`).join(', ');
    throw new JobRuleError('cycle', `Jobs read each other's output in a cycle: ${chain}.`, ids);
  }
  const readers = jobs.flatMap((job, index) => job.readsProgram ? [index] : []);
  const others = jobs.flatMap((job, index) => job.readsProgram ? [] : [index]);
  for (;;) {
    let changed = false;
    for (const reader of readers) {
      for (const other of others) {
        if (!edges.reaches(reader, other) && !edges.reaches(other, reader)) {
          edges.add(other, reader);
          changed = true;
        }
      }
    }
    if (changed) continue;
    const tie = readers.flatMap(first => readers.filter(second => second > first).map((second): [number, number] => [first, second]))
      .find(([first, second]) => !edges.reaches(first, second) && !edges.reaches(second, first));
    if (!tie) return edges;
    edges.add(tie[0], tie[1]);
  }
}

/** A run order that keeps every edge and, among the jobs free to run, takes the first in config order. */
function runOrder(count: number, edges: Edges): number[] {
  const waiting = new Array<number>(count).fill(0);
  for (const targets of edges.before) for (const target of targets) waiting[target] = (waiting[target] ?? 0) + 1;
  const done = new Set<number>();
  const order: number[] = [];
  while (order.length < count) {
    const next = waiting.findIndex((blockers, job) => blockers === 0 && !done.has(job));
    done.add(next);
    order.push(next);
    for (const target of edges.before[next] ?? []) waiting[target] = (waiting[target] ?? 0) - 1;
  }
  return order;
}

/**
 * Check the facts of `jobs` (in config order) against the generic rules of core and derive the run order.
 *
 * Throws a `JobRuleError` for a contract with two providers or a needed contract with no provider, an output that overlaps another
 * or lies in golem.yaml or the `.golem/` folder, a root or an app-imported output outside the tsconfig folder, and a cycle of reads.
 * `ModelBoundary` is not required of core: with no provider the rewrite serves SDK models only.
 *
 * A program reader sees the jobs after it as follows: the files of a later job that provides the models boundary are stubbed from
 * the boundary, and every other later output is left out of its program.
 */
export function resolveJobPlan(jobs: readonly JobFacts[], context: JobRuleContext): JobPlan {
  const providers = providersOf(jobs);
  checkOutputs(jobs, context);
  checkContainment(jobs, context);
  const order = runOrder(jobs.length, orderEdges(jobs)).map(index => jobs[index] as JobFacts);
  const programViews: Record<string, ProgramView> = {};
  for (const [position, job] of order.entries()) {
    if (!job.readsProgram) continue;
    const later = order.slice(position + 1);
    const stubbed = later.filter(other => other.provides.includes(MODEL_BOUNDARY));
    programViews[job.id] = {
      stubbedProviders: stubbed.map(other => other.id),
      laterOutputs: later.filter(other => !stubbed.includes(other)).flatMap(other => other.outputs.map(output => output.path)),
    };
  }
  return { order: order.map(job => job.id), providers, programViews };
}
