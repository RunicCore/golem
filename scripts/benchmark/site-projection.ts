import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BENCH_OPERATIONS, BENCH_SERIES_COUNT, GOLEM_ADAPTERS, PAYLOADS, REPOSITORY_BLOB_URL, adapterSpec, operationSpec, payloadSpec, type AdapterId, type OperationId, type PayloadId } from './cases.js';
import { FULL_RESULTS_FILE, isBenchmarkResults, type BenchmarkResults } from './results-schema.js';
import { costTable, type CostRow } from './tables.js';

export type CostCells = Omit<CostRow, 'payload' | 'operation'>;

/**
 * What the benchmarks page may show: golem's own numbers and golem against itself (R-30). The full results file keeps
 * every library for the console tables; this projection drops them before anything reaches the browser bundle. The
 * components import only its types, so the bundle holds no benchmark spec of another library either.
 */
export interface BenchmarkSiteProjection {
  readonly schemaVersion: 1;
  /** One line: when, where and how the numbers were measured. */
  readonly measured: string;
  /** One column for each golem setup that the run timed; `series` names its color class. */
  readonly columns: readonly { readonly id: AdapterId; readonly label: string; readonly sourceUrl: string; readonly series: string }[];
  /** One block for each payload with a number; a cell is the median ops/s, or null when the setup has no such operation. */
  readonly speeds: readonly {
    readonly payload: { readonly id: string; readonly label: string; readonly bytes: number; readonly description: string; readonly sourceUrl: string };
    readonly rows: readonly { readonly operation: { readonly id: string; readonly label: string }; readonly cells: readonly (number | null)[] }[];
  }[];
  /** The cost table, one block for each payload with a row. It reads golem adapters only. */
  readonly cost: readonly {
    readonly payload: { readonly id: string; readonly label: string; readonly description: string };
    readonly rows: readonly { readonly operation: { readonly id: string; readonly label: string }; readonly cells: CostCells }[];
  }[];
}

export function benchmarkSiteProjection(results: BenchmarkResults): BenchmarkSiteProjection {
  const columns = GOLEM_ADAPTERS.filter(id => results.adapters.some(a => a.id === id)).map((id, index) => {
    const spec = adapterSpec(id);
    return { id, label: spec.label, sourceUrl: `${REPOSITORY_BLOB_URL}/${spec.sourceFile}`, series: `s${(index % BENCH_SERIES_COUNT) + 1}` };
  });
  const costRows = costTable(results);
  const cost = [...new Set(costRows.map(row => row.payload))].map(payloadId => {
    const { id, label, description } = payloadSpec(payloadId as PayloadId);
    return {
      payload: { id, label, description },
      rows: costRows.filter(row => row.payload === payloadId).map(({ payload: _payload, operation, ...cells }) => ({
        operation: { id: operation, label: operationSpec(operation as OperationId).label }, cells,
      })),
    };
  });
  const median = new Map(results.cases.flatMap(c => c.opsPerSec ? [[`${c.payload}/${c.operation}/${c.adapter}`, c.opsPerSec.median] as const] : []));
  const speeds = PAYLOADS.flatMap(spec => {
    const recorded = results.payloads.find(p => p.id === spec.id);
    const rows = BENCH_OPERATIONS
      .map(operation => ({ operation: { id: operation.id, label: operation.label }, cells: columns.map(column => median.get(`${spec.id}/${operation.id}/${column.id}`) ?? null) }))
      .filter(row => row.cells.some(cell => cell !== null));
    return recorded && rows.length > 0
      ? [{ payload: { id: spec.id, label: spec.label, bytes: recorded.bytes, description: spec.description, sourceUrl: `${REPOSITORY_BLOB_URL}/${spec.sourceFile}` }, rows }]
      : [];
  });
  const sha = results.git.sha === 'uncommitted' ? 'uncommitted source' : results.git.sha.slice(0, 7) + (results.git.dirty ? ' + local changes' : '');
  const { node, cpu, os, arch } = results.environment;
  return {
    schemaVersion: 1,
    measured: `Measured ${results.measuredAt.slice(0, 10)} · Node ${node} · ${cpu} · ${os}/${arch} · ${sha} · median ops/s of ${results.settings.batches} batches`,
    columns,
    speeds,
    cost,
  };
}

/** Reads the committed full results of the workspace and projects them. A file that fails the structural check stops the docs build. */
export function buildBenchmarkSiteProjection(workspaceRoot: string): BenchmarkSiteProjection {
  const parsed: unknown = JSON.parse(readFileSync(path.join(workspaceRoot, FULL_RESULTS_FILE), 'utf8'));
  if (!isBenchmarkResults(parsed)) throw new Error(`${FULL_RESULTS_FILE} is not a valid results file. Run npm run bench to replace it.`);
  return benchmarkSiteProjection(parsed);
}
