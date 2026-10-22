import { ALL_PAYLOADS, COST_ROW_OPERATIONS, VALIDATION_COLUMNS, type AdapterId } from './cases.js';
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
export function costTable(results: Pick<BenchmarkResults, 'cases' | 'cost'>): readonly CostRow[] {
  const medians: Medians = new Map([...results.cases, ...(results.cost?.cases ?? [])]
    .flatMap(c => c.opsPerSec ? [[`${c.payload}/${c.operation}/${c.adapter}`, c.opsPerSec.median] as const] : []));
  const rows: CostRow[] = [];
  for (const payload of ALL_PAYLOADS) {
    for (const operation of COST_ROW_OPERATIONS) {
      const cell = (adapter: AdapterId, off = false): CostCell => {
        // Validate has no "off" mode: a build with validation off has nothing to call.
        if (off && operation === 'validate') return { kind: 'not-applicable' };
        const value = medians.get(`${payload.id}/${operation}/${adapter}`);
        return value === undefined ? { kind: 'not-run' } : { kind: 'ops', value };
      };
      const imodelOff = cell(VALIDATION_COLUMNS.imodel.off, true);
      const imodelOn = cell(VALIDATION_COLUMNS.imodel.on);
      const iobjectOff = cell(VALIDATION_COLUMNS.iobject.off, true);
      const iobjectOn = cell(VALIDATION_COLUMNS.iobject.on);
      const row: CostRow = {
        payload: payload.id, operation, imodelOff, imodelOn, imodelOnOverOff: ratio(imodelOn, imodelOff),
        iobjectOff, iobjectOn, iobjectOnOverOff: ratio(iobjectOn, iobjectOff), imodelOverIobject: ratio(imodelOn, iobjectOn),
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
  const widths = [9, 10, 12, 12, 8, 12, 12, 8, 14];
  const line = (cells: readonly string[]): string => cells.map((c, i) => i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join(' ');
  return [
    line(['', '', 'IModel off', 'IModel on', 'on/off', 'IObject off', 'IObject on', 'on/off', 'IModel/IObject']),
    ...rows.map(r => line([r.payload, r.operation, ...[r.imodelOff, r.imodelOn, r.imodelOnOverOff, r.iobjectOff, r.iobjectOn, r.iobjectOnOverOff, r.imodelOverIobject].map(text)])),
  ].join('\n');
}
