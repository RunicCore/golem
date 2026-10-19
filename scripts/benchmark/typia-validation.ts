import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepare, root } from './project.js';
import { summarize, type BatchSample } from './results.js';
import { sampleSync, schedule } from './sampling.js';
import type { CompareCase } from './fixtures/typia/compare-case.js';

/**
 * Golem's validators and codecs against typia's `is`, `assert` and `equals`, and against hand-written decode and
 * encode, on one set of models (scripts/benchmark/fixtures/typia/typia-comparison.ts). Every case runs in this
 * process, interleaved, so host load moves both sides together; read the ratios, not the absolute numbers.
 * Writes nothing under docs/: the committed results.json belongs to `npm run bench`.
 */
const SETTINGS = { warmupMs: 90, batchMs: 40, batches: 8 };
const TYPIA_FIXTURES = path.join(root, 'scripts/benchmark/fixtures/typia');

interface CompareModule { verifyCompareModels(): void; createCompareCases(): readonly CompareCase[]; consume(value: unknown): number }

const MODELS = ['flat', 'nested', 'union', 'array', 'tuple'] as const;
const fixed = (value: number): string => Math.round(value).toLocaleString('en-US');
const ratio = (a: number, b: number): string => (a / b).toFixed(2);

function measure(module: CompareModule, cases: readonly CompareCase[]): Map<CompareCase, BatchSample[]> {
  const samples = new Map(cases.map(c => [c, [] as BatchSample[]]));
  for (const step of schedule(cases.length, SETTINGS)) {
    const item = cases[step.index];
    const result = sampleSync(item.run, module.consume, step.durationMs);
    if (step.timed) samples.get(item)?.push({ iterations: result.iterations, elapsedMs: result.elapsedMs });
  }
  return samples;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  return rows.map(row => row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join('  ')).join('\n');
}

async function main(): Promise<void> {
  mkdirSync(path.join(root, '.cache'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/benchmark-work-'));
  try {
    process.stderr.write('Preparing the project (generation and compile)…\n');
    const built = prepare(directory, 'validating', [TYPIA_FIXTURES]);
    const module: CompareModule = await import(pathToFileURL(path.join(path.dirname(built), 'typia-comparison.js')).href);
    module.verifyCompareModels();
    const cases = module.createCompareCases();
    const started = performance.now();
    const samples = measure(module, cases);
    const windowSeconds = (performance.now() - started) / 1000;
    const median = (model: string, task: string, side: string): number => {
      const found = cases.find(c => c.model === model && c.task === task && c.side === side);
      const taken = found && samples.get(found);
      if (!taken) throw new Error(`No samples for ${model}/${task}/${side}`);
      return summarize(taken).median;
    };
    const rows: string[][] = [['model', 'golem validate', 'golem assert', 'typia is', 'typia assert', 'typia equals', 'validate/is', 'assert/assert', 'validate/equals']];
    for (const model of MODELS) {
      const [gv, ga, ti, ta, te] = ['golem validate', 'golem assert', 'typia is', 'typia assert', 'typia equals'].map(side => median(model, 'validate', side));
      rows.push([model, fixed(gv), fixed(ga), fixed(ti), fixed(ta), fixed(te), ratio(gv, ti), ratio(ga, ta), ratio(gv, te)]);
    }
    const conversion: string[][] = [['model', 'task', 'golem', 'golem validate off', 'hand-written', 'golem/hand', 'off/hand']];
    for (const model of MODELS) for (const [task, name] of [['decode', 'fromWireFormat'], ['encode', 'toWireFormat']] as const) {
      const [g, off, hand] = [`golem ${name}`, `golem ${name}, validate off`, 'hand-written'].map(side => median(model, task, side));
      conversion.push([model, task, fixed(g), fixed(off), fixed(hand), ratio(g, hand), ratio(off, hand)]);
    }
    process.stdout.write(`Validation, ops/s (median of ${SETTINGS.batches} batches of ${SETTINGS.batchMs} ms)\n${table(rows)}\n\n`);
    process.stdout.write(`Decode and encode, ops/s\n${table(conversion)}\n\n`);
    process.stdout.write(`Measured window ${windowSeconds.toFixed(1)} s for ${cases.length} cases\n`);
    const raw = path.join(root, '.cache/benchmark/typia-validation.json');
    mkdirSync(path.dirname(raw), { recursive: true });
    writeFileSync(raw, JSON.stringify({ settings: SETTINGS, windowSeconds, cases: cases.map(c => ({ model: c.model, task: c.task, side: c.side, samples: samples.get(c) })) }, null, 2));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
