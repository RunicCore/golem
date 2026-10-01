import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBenchmarkResults, type BenchmarkResults, type OpsPerSec } from './results-schema.js';

export interface CompareRow { readonly key: string; readonly before?: number; readonly after?: number; readonly deltaPercent?: number; readonly overlap: boolean }
export interface Comparison { readonly rows: CompareRow[]; readonly onlyBefore: string[]; readonly onlyAfter: string[]; readonly warnings: string[] }

function timings(results: BenchmarkResults): Map<string, OpsPerSec> {
  const map = new Map<string, OpsPerSec>();
  for (const c of results.cases) if (c.opsPerSec) map.set(`${c.payload}/${c.operation}/${c.adapter}`, c.opsPerSec);
  return map;
}

export function compareResults(before: BenchmarkResults, after: BenchmarkResults): Comparison {
  const a = timings(before);
  const b = timings(after);
  const rows: CompareRow[] = [];
  for (const [key, x] of a) {
    const y = b.get(key);
    if (!y) continue;
    rows.push({ key, before: x.median, after: y.median, deltaPercent: Math.round((y.median / x.median - 1) * 1000) / 10, overlap: x.min <= y.max && y.min <= x.max });
  }
  const warnings: string[] = [];
  for (const field of ['node', 'os', 'arch', 'cpu', 'cpus'] as const) {
    if (before.environment[field] !== after.environment[field]) warnings.push(`${field} differs: ${before.environment[field]} → ${after.environment[field]}`);
  }
  for (const field of ['warmupMs', 'batchMs', 'batches', 'rounds'] as const) {
    if ((before.settings[field] ?? 1) !== (after.settings[field] ?? 1)) warnings.push(`settings.${field} differs: ${before.settings[field]} → ${after.settings[field]}`);
  }
  if (before.git.sha !== after.git.sha || before.git.dirty !== after.git.dirty) {
    warnings.push(`git differs: ${before.git.sha}${before.git.dirty ? ' (dirty)' : ''} → ${after.git.sha}${after.git.dirty ? ' (dirty)' : ''}`);
  }
  const supportAfter = new Map(after.cases.map(c => [`${c.payload}/${c.operation}/${c.adapter}`, c.support]));
  for (const c of before.cases) {
    const key = `${c.payload}/${c.operation}/${c.adapter}`;
    const next = supportAfter.get(key);
    if (next !== undefined && next !== c.support) warnings.push(`${key} support differs: ${c.support} → ${next}`);
  }
  for (const name of new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])) {
    if (before.packages[name] !== after.packages[name]) warnings.push(`${name} differs: ${before.packages[name] ?? 'absent'} → ${after.packages[name] ?? 'absent'}`);
  }
  return {
    rows,
    onlyBefore: [...a.keys()].filter(key => !b.has(key)),
    onlyAfter: [...b.keys()].filter(key => !a.has(key)),
    warnings,
  };
}

export function formatComparison(comparison: Comparison): string {
  const lines = comparison.warnings.map(w => `warning: ${w}`);
  lines.push(`${'case'.padEnd(40)} ${'before'.padStart(12)} ${'after'.padStart(12)} ${'delta'.padStart(8)}`);
  for (const row of comparison.rows) {
    const delta = `${row.deltaPercent !== undefined && row.deltaPercent > 0 ? '+' : ''}${row.deltaPercent ?? 0}%`;
    lines.push(`${row.key.padEnd(40)} ${Math.round(row.before ?? 0).toLocaleString('en-US').padStart(12)} ${Math.round(row.after ?? 0).toLocaleString('en-US').padStart(12)} ${delta.padStart(8)}${row.overlap ? ' ~' : ''}`);
  }
  for (const key of comparison.onlyBefore) lines.push(`only in before: ${key}`);
  for (const key of comparison.onlyAfter) lines.push(`only in after: ${key}`);
  lines.push('~ = ranges overlap; the difference may be noise.');
  return lines.join('\n');
}

function load(file: string): BenchmarkResults {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isBenchmarkResults(value)) throw new Error(`${file} is not a schema-2 benchmark results file`);
  return value;
}

export function main(args: readonly string[]): void {
  if (args.length !== 2) throw new Error('Usage: npm run bench:compare -- <before.json> <after.json>');
  process.stdout.write(`${formatComparison(compareResults(load(args[0]), load(args[1])))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
