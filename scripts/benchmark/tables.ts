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

/** Table 1 as console text: one block per group, a rank after each speed, a mark after a cell that does less work, and the summary. */
export function formatCompareTable(table: ReturnType<typeof compareTable>, labels: ReadonlyMap<string, string>): string {
  const marks = new Map<string, string>();
  const blocks = table.groups.map(group => {
    const libraries = group.summary.map(s => s.adapter);
    const speed = (cell: CompareCell | undefined): string => {
      if (cell === undefined) return 'no check';
      if (cell.kind === 'not-supported') return 'no conversion';
      if (cell.kind === 'not-run') return '-';
      const mark = cell.mark ? '*' : '';
      if (cell.mark) marks.set(mark, cell.mark);
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
  const notes = [...marks.values()].map(reason => `* ${reason}`);
  const ties = table.band === undefined
    ? 'No noise band in these results: ranks have no ties.'
    : `Libraries within ${(table.band * 100).toFixed(1)}% of the fastest of a run (the control's spread) tie and share its rank.`;
  return [...blocks, ...notes, ties].join('\n\n');
}
