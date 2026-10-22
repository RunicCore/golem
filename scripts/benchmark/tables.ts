import { adapterSpec, ALL_PAYLOADS, BENCH_OPERATIONS, COST_ROW_OPERATIONS, GROUPS, PAYLOADS, VALIDATION_COLUMNS, type AdapterId, type GroupId } from './cases.js';
import type { BenchmarkResults } from './results-schema.js';

/**
 * A cell of the cost table. `ops` is a median in ops/s, `ratio` a quotient of two medians. `not-applicable` is a pair
 * that does not exist (validate has no "off" mode). `not-run` is a number the run did not time.
 */
export type CostCell =
  | { readonly kind: 'ops'; readonly value: number }
  | { readonly kind: 'ratio'; readonly value: number }
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'not-run' };

/** The validation columns of the cost table for one payload and operation. A ratio divides the compared mode by its reference mode. */
export interface CostRow {
  readonly payload: string;
  readonly operation: string;
  readonly imodelOff: CostCell;
  readonly imodelOn: CostCell;
  /** IModel with validation on, divided by IModel with validation off. */
  readonly imodelOnOverOff: CostCell;
  readonly iobjectOff: CostCell;
  readonly iobjectOn: CostCell;
  /** IObject with validation on, divided by IObject with validation off. */
  readonly iobjectOnOverOff: CostCell;
  /** IModel with validation on, divided by IObject with validation on. */
  readonly imodelOverIobject: CostCell;
  /** On the serde-many rows: serde-many divided by serde-none for the same operation, IModel with validation on (PO4). Not applicable on every other row. */
  readonly serdeManyOverNone: CostCell;
  /**
   * The reading operations (parse, decode, validate) on one broken variant, divided by the same operation on valid input,
   * IModel with validation on (PO4). Not applicable for stringify and encode. It has no rank and no stop rule (F-250).
   */
  readonly invalidOverValid: CostCell;
}

type Medians = ReadonlyMap<string, number>;

function ratio(compared: CostCell, reference: CostCell): CostCell {
  if (compared.kind === 'not-applicable' || reference.kind === 'not-applicable') return { kind: 'not-applicable' };
  if (compared.kind !== 'ops' || reference.kind !== 'ops') return { kind: 'not-run' };
  return { kind: 'ratio', value: compared.value / reference.value };
}

/**
 * The validation columns of the cost table, one row for each payload and operation that has a timing, in table order.
 * It reads the compare timings and the cost timings together, so each case is timed once and a ratio is never stored.
 */
export function costTable(results: Pick<BenchmarkResults, 'cases' | 'cost' | 'invalid'>): readonly CostRow[] {
  const medians: Medians = new Map([...results.cases, ...(results.cost?.cases ?? [])]
    .flatMap(c => c.opsPerSec ? [[`${c.payload}/${c.operation}/${c.adapter}`, c.opsPerSec.median] as const] : []));
  const invalidMedians: Medians = new Map((results.invalid?.cases ?? [])
    .flatMap(c => c.opsPerSec ? [[`${c.payload}/${c.operation}/${c.adapter}`, c.opsPerSec.median] as const] : []));
  const rows: CostRow[] = [];
  for (const payload of ALL_PAYLOADS) {
    for (const operation of COST_ROW_OPERATIONS) {
      const timing = (payloadId: string, adapter: AdapterId): CostCell => {
        const value = medians.get(`${payloadId}/${operation}/${adapter}`);
        return value === undefined ? { kind: 'not-run' } : { kind: 'ops', value };
      };
      const cell = (adapter: AdapterId, off = false): CostCell =>
        // Validate has no "off" mode: a build with validation off has nothing to call.
        off && operation === 'validate' ? { kind: 'not-applicable' } : timing(payload.id, adapter);
      const imodelOff = cell(VALIDATION_COLUMNS.imodel.off, true);
      const imodelOn = cell(VALIDATION_COLUMNS.imodel.on);
      const iobjectOff = cell(VALIDATION_COLUMNS.iobject.off, true);
      const iobjectOn = cell(VALIDATION_COLUMNS.iobject.on);
      const invalidRatio = (): CostCell => {
        if (!['parse', 'decode', 'validate'].includes(operation)) return { kind: 'not-applicable' };
        const invalid = invalidMedians.get(`${payload.id}/${operation}/${VALIDATION_COLUMNS.imodel.on}`);
        return invalid === undefined ? { kind: 'not-run' } : ratio({ kind: 'ops', value: invalid }, imodelOn);
      };
      const row: CostRow = {
        payload: payload.id, operation, imodelOff, imodelOn, imodelOnOverOff: ratio(imodelOn, imodelOff),
        iobjectOff, iobjectOn, iobjectOnOverOff: ratio(iobjectOn, iobjectOff), imodelOverIobject: ratio(imodelOn, iobjectOn),
        invalidOverValid: invalidRatio(),
        serdeManyOverNone: payload.id === 'serde-many' ? ratio(imodelOn, timing('serde-none', VALIDATION_COLUMNS.imodel.on)) : { kind: 'not-applicable' },
      };
      if ([imodelOff, imodelOn, iobjectOff, iobjectOn].some(c => c.kind === 'ops')) rows.push(row);
    }
  }
  return rows;
}

function text(cell: CostCell): string {
  switch (cell.kind) {
    case 'ops': return Math.round(cell.value).toLocaleString('en-US');
    case 'ratio': return `${cell.value.toFixed(2)}x`;
    case 'not-applicable': return 'n/a';
    case 'not-run': return '-';
  }
}

/** The cost table's validation columns as console text. */
export function formatCostTable(rows: readonly CostRow[]): string {
  const widths = [14, 10, 12, 12, 8, 12, 12, 8, 14, 15, 13];
  const line = (cells: readonly string[]): string => cells.map((c, i) => i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join(' ');
  return [
    line(['', '', 'IModel off', 'IModel on', 'on/off', 'IObject off', 'IObject on', 'on/off', 'IModel/IObject', 'serde many/none', 'invalid/valid']),
    ...rows.map(r => line([r.payload, r.operation, ...[r.imodelOff, r.imodelOn, r.imodelOnOverOff, r.iobjectOff, r.iobjectOn, r.iobjectOnOverOff, r.imodelOverIobject, r.serdeManyOverNone, r.invalidOverValid].map(text)])),
  ].join('\n');
}

/*
 * The compare table (Table 1): ranks inside a group, per row, and a summary for each library of a group.
 *
 * A row is one payload and one operation. The score of a cell is its median ops/s. A rank is a competition rank: 1 plus
 * the number of libraries that are in an earlier run, so tied libraries share a rank and the next run skips the places it
 * used (1, 1, 3). Libraries of other groups, and a rejected value (F-250), take no part.
 *
 * A tie is a ratio inside the run's noise band: a library ties the fastest library of its run when
 * slower / faster >= 1 - band, with the band the control's spread (`results.noise.controlSpread`). The tie is anchored,
 * not chained (PO6): a run starts at its fastest library, and a later library joins it only when it is inside the band of
 * that fastest library. So A ties B and B ties C does not make A tie C: if C is outside the band of A, C starts the next
 * run and takes its own rank, even though C is inside the band of B. Each library gets exactly one rank.
 *
 * A file with no noise band (measured before the control) ranks with no ties.
 */
export function rankSpeeds(speeds: readonly number[], band: number | undefined): readonly number[] {
  const order = speeds.map((_, index) => index).sort((a, b) => speeds[b] - speeds[a]);
  const ranks: number[] = [];
  let leader = -1;
  let leaderRank = 0;
  for (const [position, index] of order.entries()) {
    if (leader < 0 || band === undefined || speeds[index] < speeds[leader] * (1 - band)) { leader = index; leaderRank = position + 1; }
    ranks[index] = leaderRank;
  }
  return ranks;
}

export type CompareCell =
  | { readonly kind: 'ops'; readonly value: number; readonly rank: number; readonly mark?: string }
  | { readonly kind: 'not-supported'; readonly note: string }
  | { readonly kind: 'not-run' };

/** The libraries that do the operation in this group, in group order. */
export interface CompareRow { readonly payload: string; readonly operation: string; readonly cells: readonly { readonly adapter: AdapterId; readonly cell: CompareCell }[] }

/**
 * `score` is the geometric mean of the library's speed over the row leader's speed, over the `rows` that every library of the group
 * supports, out of `of` rows that the run timed or marked unsupported. It is at most 1; the leader of every row scores 1. It is absent when `rows` is 0.
 */
export interface GroupSummary { readonly adapter: AdapterId; readonly label: string; readonly score?: number; readonly rows: number; readonly of: number }
export interface CompareGroup { readonly id: GroupId; readonly label: string; readonly rows: readonly CompareRow[]; readonly summary: readonly GroupSummary[] }

/** Table 1 of the results: ranks and summaries, derived from the cases (PO2). `band` is the noise band the ties used, or undefined for no ties. */
export function compareTable(results: Pick<BenchmarkResults, 'cases' | 'adapters' | 'payloads' | 'noise'>): { readonly band: number | undefined; readonly groups: readonly CompareGroup[] } {
  const band = results.noise?.controlSpread;
  const found = new Map(results.cases.map(c => [`${c.payload}/${c.operation}/${c.adapter}`, c] as const));
  const payloadIds = PAYLOADS.filter(p => results.payloads.some(r => r.id === p.id)).map(p => p.id);
  const groups: CompareGroup[] = [];
  for (const group of GROUPS) {
    const present = new Set(results.adapters.filter(a => a.group === group.id).map(a => a.id));
    const rows: CompareRow[] = [];
    for (const payload of payloadIds) for (const operation of BENCH_OPERATIONS) {
      const members = group.operations[operation.id].filter(id => present.has(id) && found.has(`${payload}/${operation.id}/${id}`));
      if (members.length === 0) continue;
      const speeds = members.map(id => found.get(`${payload}/${operation.id}/${id}`)?.opsPerSec?.median);
      const timed = members.flatMap((id, i) => speeds[i] === undefined ? [] : [i]);
      const ranks = rankSpeeds(timed.map(i => speeds[i] as number), band);
      rows.push({
        payload, operation: operation.id,
        cells: members.map((adapter, i) => {
          const recorded = found.get(`${payload}/${operation.id}/${adapter}`);
          const value = speeds[i];
          if (value === undefined) return { adapter, cell: recorded?.support === 'none' ? { kind: 'not-supported', note: recorded.note ?? '' } : { kind: 'not-run' } };
          const mark = adapterSpec(adapter).lessWork;
          return { adapter, cell: { kind: 'ops', value, rank: ranks[timed.indexOf(i)], ...(mark ? { mark } : {}) } };
        }),
      });
    }
    if (rows.length === 0) continue;
    const supported = rows.filter(r => r.cells.every(c => c.cell.kind === 'ops'));
    const libraries = [...new Set([...group.operations.parse, ...group.operations.stringify, ...group.operations.validate])].filter(id => present.has(id));
    const summary = libraries
      .map(adapter => {
        const ratios = supported.flatMap(r => {
          const own = r.cells.find(c => c.adapter === adapter)?.cell;
          if (own?.kind !== 'ops') return [];
          const leader = Math.max(...r.cells.map(c => c.cell.kind === 'ops' ? c.cell.value : 0));
          return [own.value / leader];
        });
        const label = results.adapters.find(a => a.id === adapter)?.label ?? adapter;
        return { adapter, label, rows: ratios.length, of: rows.length, ...(ratios.length > 0 ? { score: Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length) } : {}) };
      });
    groups.push({ id: group.id, label: group.label, rows, summary });
  }
  return { band, groups };
}

const LESS_WORK_SYMBOLS = ['*', '\u2020', '\u2021', '\u00a7'];

/** Table 1 as console text: one block per group, a rank after each speed, a mark after a cell that does less work, and the summary. */
export function formatCompareTable(table: ReturnType<typeof compareTable>, labels: ReadonlyMap<string, string>): string {
  // Each reason takes the next symbol, as the page does.
  const symbols = new Map<string, string>();
  const blocks = table.groups.map(group => {
    const libraries = group.summary.map(s => s.adapter);
    const speed = (cell: CompareCell | undefined): string => {
      if (cell === undefined) return 'no check';
      if (cell.kind === 'not-supported') return 'no conversion';
      if (cell.kind === 'not-run') return '-';
      if (cell.mark && !symbols.has(cell.mark)) symbols.set(cell.mark, LESS_WORK_SYMBOLS[symbols.size % LESS_WORK_SYMBOLS.length]);
      const mark = cell.mark ? symbols.get(cell.mark) : '';
      return `${Math.round(cell.value).toLocaleString('en-US')} #${cell.rank}${mark}`;
    };
    const widths = [14, 10, ...libraries.map(id => Math.max((labels.get(id) ?? id).length, 18))];
    const line = (cells: readonly string[]): string => cells.map((c, i) => i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join(' ');
    return [
      group.label,
      line(['payload', 'operation', ...libraries.map(id => labels.get(id) ?? id)]),
      ...group.rows.map(row => line([row.payload, row.operation, ...libraries.map(id => speed(row.cells.find(c => c.adapter === id)?.cell))])),
      line(['summary', 'score', ...group.summary.map(s => s.score === undefined ? '-' : `${s.score.toFixed(2)} (${s.rows} of ${s.of})`)]),
    ].join('\n');
  });
  const notes = [...symbols].map(([reason, symbol]) => `${symbol} ${reason}`);
  const ties = table.band === undefined
    ? 'No noise band in these results: ranks have no ties.'
    : `Libraries within ${(table.band * 100).toFixed(1)}% of the fastest of a run (the control's spread) tie and share its rank.`;
  return [...blocks, ...notes, ties].join('\n\n');
}

/** A median in ops/s of the base and of this checkout, from the same rounds. */
export interface ReleasePair { readonly base: number; readonly head: number }
/** One case timed on both sides of the release check: over the whole session (`base`, `head`) and in each half of its rounds (`halves`). */
export interface ReleaseTiming extends ReleasePair { readonly key: string; readonly halves: readonly ReleasePair[] }
/** `ratio` is this checkout over the base, `halfRatios` the same in each half. `slower` is a ratio below `1 - band` in every half. */
export interface ReleaseRow extends ReleaseTiming { readonly ratio: number; readonly halfRatios: readonly number[]; readonly slower: boolean }
/** The geometric mean of the ratios of one adapter, over the whole session and in each half. */
export interface ReleaseMean { readonly adapter: string; readonly ratio: number; readonly halfRatios: readonly number[] }
export interface ReleaseVerdict { readonly band: number; readonly rows: readonly ReleaseRow[]; readonly failing: readonly ReleaseRow[]; readonly means: readonly ReleaseMean[]; readonly verdict: 'pass' | 'stop' }

function checkPair(pair: ReleasePair, what: string): void {
  if (!(pair.base > 0) || !(pair.head > 0) || !Number.isFinite(pair.base) || !Number.isFinite(pair.head)) throw new Error(`Cannot judge the release: invalid timing for ${what}`);
}

/**
 * The noise band of a release session, from the control timed on both sides. Native JSON is the same code on both sides, so
 * each control ratio (this checkout over the base) away from 1 is noise of the method. The band is the largest distance
 * from 1 (`band`); the 90th percentile of the distances is reported beside it (`p90`).
 */
export function releaseBand(controlRatios: readonly number[]): { readonly band: number; readonly p90: number } {
  if (controlRatios.length === 0) throw new Error('Cannot take the release band: no control ratio');
  if (controlRatios.some(r => !(r > 0) || !Number.isFinite(r))) throw new Error('Cannot take the release band: invalid control ratio');
  const distances = controlRatios.map(r => Math.abs(1 - r)).sort((a, b) => a - b);
  return { band: distances[distances.length - 1], p90: distances[Math.ceil(distances.length * 0.9) - 1] };
}

/**
 * The release check's verdict on valid-path cases (A-62 R9). A case fails when this checkout runs below the base by more than
 * the band in every half of the rounds, so a drop that shows in one half only is noise. A ratio exactly at `1 - band` passes.
 * One failing case stops the release. A check that compared nothing, or has no usable band, is an error, never a pass.
 */
export function releaseVerdict(timings: readonly ReleaseTiming[], band: number): ReleaseVerdict {
  if (!(band >= 0) || !Number.isFinite(band)) throw new Error(`Cannot judge the release: the noise band is ${band}`);
  if (timings.length === 0) throw new Error('Cannot judge the release: no case was timed on both sides');
  const below = (pair: ReleasePair): boolean => pair.head < pair.base * (1 - band);
  const rows = timings.map(t => {
    for (const pair of [t, ...t.halves]) checkPair(pair, t.key);
    return { ...t, ratio: t.head / t.base, halfRatios: t.halves.map(h => h.head / h.base), slower: t.halves.length > 0 && t.halves.every(below) };
  });
  const adapterOf = (key: string): string => key.slice(key.lastIndexOf('/') + 1);
  const geometricMean = (ratios: readonly number[]): number => Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length);
  const means = [...new Set(rows.map(r => adapterOf(r.key)))].map(adapter => {
    const mine = rows.filter(r => adapterOf(r.key) === adapter);
    return { adapter, ratio: geometricMean(mine.map(r => r.ratio)), halfRatios: mine[0].halves.map((_, h) => geometricMean(mine.map(r => r.halfRatios[h]))) };
  });
  const failing = rows.filter(r => r.slower);
  return { band, rows, failing, means, verdict: failing.length > 0 ? 'stop' : 'pass' };
}

/** The ratio of every case over the session and in each half, the failing ones marked. `mark: false` shows ratios with no judgment (the invalid path has no stop rule, F-250). */
export function formatReleaseRows(rows: readonly ReleaseRow[], mark: boolean): string {
  const halves = rows[0]?.halfRatios.length ?? 0;
  const lines = [`${'case'.padEnd(44)} ${'base'.padStart(12)} ${'this'.padStart(12)} ${'ratio'.padStart(7)}${Array.from({ length: halves }, (_, h) => `${`half ${h + 1}`.padStart(8)}`).join('')}`];
  for (const r of rows) {
    const ops = (value: number): string => Math.round(value).toLocaleString('en-US').padStart(12);
    lines.push(`${r.key.padEnd(44)} ${ops(r.base)} ${ops(r.head)} ${r.ratio.toFixed(3).padStart(7)}${r.halfRatios.map(h => h.toFixed(3).padStart(8)).join('')}${mark && r.slower ? '  SLOWER' : ''}`);
  }
  return lines.join('\n');
}

export function formatReleaseVerdict(verdict: ReleaseVerdict): string {
  const means = `Geometric mean of this over base, per adapter (whole session; each half):\n${verdict.means.map(m => `  ${m.adapter.padEnd(18)} ${m.ratio.toFixed(3)}  ${m.halfRatios.map(h => h.toFixed(3)).join('  ')}`).join('\n')}`;
  const band = `noise band ${(verdict.band * 100).toFixed(1)}% (largest control ratio away from 1)`;
  return verdict.verdict === 'pass'
    ? `${means}\n\nPASS: ${verdict.rows.length} valid-path cases, none below ${(1 - verdict.band).toFixed(3)} of the base in both halves; ${band}`
    : `${means}\n\nSTOP: ${verdict.failing.length} of ${verdict.rows.length} valid-path cases are below ${(1 - verdict.band).toFixed(3)} of the base in both halves (${band}):\n${verdict.failing.map(r => `  ${r.key} ratio ${r.ratio.toFixed(3)}, halves ${r.halfRatios.map(h => h.toFixed(3)).join(' and ')}`).join('\n')}`;
}
