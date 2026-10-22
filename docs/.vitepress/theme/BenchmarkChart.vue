<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import raw from '../../public/benchmarks/results.json';
import { isBenchmarkResults } from '../../../scripts/benchmark/results-schema.js';
import { BENCH_SERIES_COUNT, GROUPS } from '../../../scripts/benchmark/cases.js';
import { compareTable } from '../../../scripts/benchmark/tables.js';
import BenchmarkCostTable from './BenchmarkCostTable.vue';

const data = isBenchmarkResults(raw) ? raw : undefined;
// An empty placeholder means nothing is published yet; anything else that fails the check is a broken file.
const published = typeof raw === 'object' && raw !== null && Object.keys(raw).length > 0;
const exact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const groups = data?.groups ?? [];
const payloads = data?.payloads ?? [];
const groupId = ref(groups[0]?.id ?? '');
const codePayloadId = ref(payloads[0]?.id ?? '');
/** What an operation does in the selected group; falls back to the generic description. */
const operationText = (operation: { id: string; description: string }): string =>
  GROUPS.find(g => g.id === groupId.value)?.operationDescriptions[operation.id as 'parse'] ?? operation.description;
const tabs = ref<HTMLButtonElement[]>([]);
// The page holds two tables: the compare table (Table 1, with a tab for each group) and the golem cost table (Table 2).
const views = [{ id: 'compare', label: 'Compare libraries' }, { id: 'cost', label: 'What each feature costs' }] as const;
const viewId = ref<(typeof views)[number]['id']>('compare');
const viewTabs = ref<HTMLButtonElement[]>([]);

const adapterLabel = (id: string) => data?.adapters.find(a => a.id === id)?.label ?? id;
const adapterUrl = (id: string) => data?.adapters.find(a => a.id === id)?.sourceUrl;
const bytes = (value: number) => value >= 1024 ? `${exact.format(Math.round(value / 1024))} KB` : `${value} B`;

// Ranks, ties and scores come from the one function that the console table uses (scripts/benchmark/tables.ts); the page only draws them.
const table = data ? compareTable(data) : undefined;
const tieLegend = table?.band === undefined
  ? 'These results have no noise band, so no ranks tie.'
  : `Libraries within ${(table.band * 100).toFixed(1)}% of the fastest tie and share its rank. The band is the spread of the control (native JSON) in this run.`;
const MARKS = ['*', '\u2020', '\u2021', '\u00a7'];

const group = computed(() => table?.groups.find(g => g.id === groupId.value));
/** One column per library, in the group's order; the series color follows the column. */
const columns = computed(() => (group.value?.summary ?? []).map((summary, index) => ({ ...summary, series: `s${(index % BENCH_SERIES_COUNT) + 1}` })));

/** A mark on a cell that does less work (R1), with the footnote that explains it. */
const footnotes = computed(() => {
  const seen = new Map<string, { symbol: string; text: string }>();
  for (const row of group.value?.rows ?? []) for (const { adapter, cell } of row.cells) {
    const key = `${adapter}\0${cell.kind === 'ops' ? cell.mark : ''}`;
    if (cell.kind === 'ops' && cell.mark && !seen.has(key)) {
      const symbol = MARKS[seen.size % MARKS.length];
      seen.set(key, { symbol, text: `${symbol} ${adapterLabel(adapter)} ${cell.mark}, so it does less work in the cells with this mark.` });
    }
  }
  return seen;
});

/** One block per payload, one row per operation. A tie is a rank that more than one library of the row holds. */
const blocks = computed(() => payloads.flatMap(payload => {
  const rows = (group.value?.rows ?? []).filter(r => r.payload === payload.id).map(row => {
    const timed = row.cells.flatMap(c => c.cell.kind === 'ops' ? [c.cell] : []);
    const leader = Math.max(...timed.map(c => c.value));
    return {
      operation: data?.operations.find(o => o.id === row.operation) ?? { id: row.operation, label: row.operation, description: '' },
      cells: columns.value.map(column => {
        const cell = row.cells.find(c => c.adapter === column.adapter)?.cell;
        return cell?.kind === 'ops'
          ? { ...cell, tie: timed.filter(t => t.rank === cell.rank).length > 1, share: cell.value / leader, symbol: cell.mark ? footnotes.value.get(`${column.adapter}\0${cell.mark}`)?.symbol : undefined }
          : cell;
      }),
    };
  });
  return rows.length ? [{ payload, rows }] : [];
}));

/** What each operation of the selected group does, once under the table. */
const operationLegend = computed(() => (data?.operations ?? [])
  .filter(operation => group.value?.rows.some(r => r.operation === operation.id))
  .map(operation => `${operation.label}: ${operationText(operation)}.`));

/** Why a library cannot run a case, once per library and payload (R10). */
const notes = computed(() => {
  const seen = new Map<string, string>();
  for (const row of group.value?.rows ?? []) for (const { adapter, cell } of row.cells) {
    if (cell.kind === 'not-supported' && cell.note) {
      const payload = payloads.find(p => p.id === row.payload)?.label ?? row.payload;
      seen.set(`${adapter}\0${row.payload}`, `${adapterLabel(adapter)} on ${payload}: ${cell.note}`);
    }
  }
  return [...seen.values()];
});

const measuredOn = computed(() => {
  if (!data) return '';
  const e = data.environment;
  const date = data.measuredAt.slice(0, 10);
  const sha = data.git.sha === 'uncommitted' ? 'uncommitted source' : data.git.sha.slice(0, 7) + (data.git.dirty ? ' + local changes' : '');
  return `Measured ${date} · Node ${e.node} · ${e.cpu} · ${e.os}/${e.arch} · ${sha} · median ops/s of ${data.settings.batches} batches`;
});

// Tabs follow the WAI-ARIA pattern: arrow keys, Home and End move between the tabs of one list.
function targetTab(event: KeyboardEvent, index: number, count: number): number | undefined {
  const last = count - 1;
  const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
    : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
  if (next !== undefined) event.preventDefault();
  return next;
}

async function onTabKey(event: KeyboardEvent, index: number): Promise<void> {
  const next = targetTab(event, index, groups.length);
  if (next === undefined) return;
  groupId.value = groups[next].id;
  await nextTick();
  tabs.value[next]?.focus();
}

async function onViewKey(event: KeyboardEvent, index: number): Promise<void> {
  const next = targetTab(event, index, views.length);
  if (next === undefined) return;
  viewId.value = views[next].id;
  await nextTick();
  viewTabs.value[next]?.focus();
}
</script>

<template>
  <div v-if="data" class="bench">
    <p class="bench-meta">{{ measuredOn }}</p>
    <div class="bench-views" role="tablist" aria-label="Table">
      <button v-for="(view, index) in views" :id="`bench-view-${view.id}`" :key="view.id" ref="viewTabs" role="tab" type="button"
        :aria-selected="view.id === viewId" :aria-controls="`bench-view-panel-${view.id}`" :tabindex="view.id === viewId ? 0 : -1"
        :class="{ on: view.id === viewId }" @click="viewId = view.id" @keydown="onViewKey($event, index)">{{ view.label }}</button>
    </div>
    <div id="bench-view-panel-compare" v-show="viewId === 'compare'" role="tabpanel" aria-labelledby="bench-view-compare">
    <div class="bench-tabs" role="tablist" aria-label="Comparison group">
      <button v-for="(group, index) in groups" :id="`bench-tab-${group.id}`" :key="group.id" ref="tabs" role="tab" type="button"
        :aria-selected="group.id === groupId" aria-controls="bench-panel" :tabindex="group.id === groupId ? 0 : -1"
        :class="{ on: group.id === groupId }" @click="groupId = group.id" @keydown="onTabKey($event, index)">{{ group.label }}</button>
    </div>
    <section id="bench-panel" role="tabpanel" :aria-labelledby="`bench-tab-${groupId}`" class="bench-panel">
    <div v-for="group in groups" v-show="group.id === groupId" :key="group.id" class="bench-explain"><slot :name="group.id">{{ group.description }}</slot></div>

    <div class="bench-frame" role="region" tabindex="0" :aria-label="`${group?.label ?? ''} speeds`">
      <table class="bench-table">
        <thead>
          <tr><th scope="col">Payload and operation</th>
            <th v-for="column in columns" :key="column.adapter" scope="col"><span class="bench-dot" :class="column.series" aria-hidden="true" /><a :href="adapterUrl(column.adapter)">{{ column.label }}</a></th></tr>
        </thead>
        <tbody v-for="block in blocks" :key="block.payload.id">
          <tr class="bench-op"><th :colspan="columns.length + 1" scope="rowgroup">{{ block.payload.label }} <small>{{ bytes(block.payload.bytes) }}</small></th></tr>
          <tr v-for="row in block.rows" :key="row.operation.id">
            <th scope="row" :title="operationText(row.operation)">{{ row.operation.label }}</th>
            <td v-for="(cell, index) in row.cells" :key="columns[index].adapter">
              <template v-if="cell?.kind === 'ops'">
                <span class="bench-rank" :class="{ tie: cell.tie, lead: cell.rank === 1 }">{{ cell.tie ? '=' : '' }}#{{ cell.rank }}<span v-if="cell.tie" class="visually-hidden"> (tied)</span></span>
                <span class="bench-ops">{{ exact.format(cell.value) }}<sup v-if="cell.symbol" class="bench-mark">{{ cell.symbol }}</sup></span>
                <span class="bench-mini"><span :class="columns[index].series" :style="{ width: `${cell.share * 100}%` }" /></span>
              </template>
              <span v-else-if="cell?.kind === 'not-supported'" class="bench-na" :title="cell.note">no conversion</span>
              <span v-else-if="cell?.kind === 'not-run'" class="bench-na">not run</span>
              <span v-else class="bench-na">no check</span>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="bench-summary">
            <th scope="row">Group score</th>
            <td v-for="column in columns" :key="column.adapter">
              <template v-if="column.score !== undefined"><span class="bench-ops">{{ column.score.toFixed(2) }}</span><small>{{ column.rows }} of {{ column.of }} rows</small></template>
              <span v-else class="bench-na">-</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <ul class="bench-notes">
      <li v-for="line in operationLegend" :key="line">{{ line }}</li>
      <li>{{ tieLegend }}<template v-if="table?.band !== undefined"> A tied cell shows <strong>=#</strong> and its rank.</template></li>
      <li>Group score: the geometric mean of a library's speed over the fastest speed of the row, for the rows that every library of the group supports. 1.00 means fastest in every row.</li>
      <li v-for="note in footnotes.values()" :key="note.text">{{ note.text }}</li>
      <li v-for="note in notes" :key="note">{{ note }}</li>
    </ul>
    <div class="bench-code">
      <h4>Code</h4>
      <div class="bench-chips" role="group" aria-label="Payload for the code">
        <button v-for="p in payloads" :key="p.id" type="button" :aria-pressed="p.id === codePayloadId" :class="{ on: p.id === codePayloadId }"
          @click="codePayloadId = p.id">{{ p.label }}</button>
      </div>
      <template v-for="group in groups" :key="group.id">
        <div v-for="p in payloads" v-show="group.id === groupId && p.id === codePayloadId" :key="`${group.id}-${p.id}`">
          <slot :name="`${group.id}-${p.id}-code`" />
        </div>
      </template>
    </div>
    </section>
    <ul class="bench-payloads">
      <li v-for="p in payloads" :key="p.id"><strong>{{ p.label }}</strong> ({{ bytes(p.bytes) }}): {{ p.description }} <a :href="p.sourceUrl">Source</a></li>
    </ul>
    </div>
    <div id="bench-view-panel-cost" v-show="viewId === 'cost'" role="tabpanel" aria-labelledby="bench-view-cost">
      <BenchmarkCostTable :results="data" />
    </div>
  </div>
  <p v-else-if="published" class="bench-missing">The published results file is not a valid results file. Run <code>npm run bench</code> to replace it.</p>
  <p v-else class="bench-missing">No benchmark results are published yet. Run <code>npm run bench</code>.</p>
</template>

<style scoped>
.bench-meta { color: var(--vp-c-text-2); font-size: 13px; margin: 8px 0 16px; }
.bench-views { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.bench-views button { border: 1px solid var(--vp-c-divider); border-radius: 6px; padding: 6px 14px; font-size: 14px; color: var(--vp-c-text-2); }
.bench-views button.on { border-color: var(--vp-c-brand-1); color: var(--vp-c-text-1); font-weight: 600; }
.bench-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--vp-c-divider); }
.bench-tabs button { padding: 8px 12px; margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--vp-c-text-2); font-size: 14px; }
.bench-tabs button.on { color: var(--vp-c-text-1); border-color: var(--vp-c-brand-1); font-weight: 600; }
.bench-views button:focus-visible, .bench-tabs button:focus-visible, .bench-chips button:focus-visible, .bench-frame:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.bench-explain { font-size: 14px; margin: 12px 0 8px; }
.bench-explain :deep(p) { margin: 0; }
/* The table scrolls inside its own frame, so the page never scrolls sideways. */
.bench-frame { overflow-x: auto; max-width: 100%; margin: 8px 0 0; }
.bench-table { display: table; width: 100%; min-width: 640px; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 14px; margin: 0; }
.bench-table th, .bench-table td { border: 0; border-bottom: 1px solid var(--vp-c-divider); padding: 8px 10px; background: none; }
.bench-table thead th { color: var(--vp-c-text-2); font-weight: 500; font-size: 13px; text-align: right; vertical-align: bottom; }
.bench-table thead th:first-child { text-align: left; }
.bench-table thead th a { color: inherit; text-decoration: underline dotted; text-underline-offset: 3px; }
.bench-table tbody th[scope="row"], .bench-table tfoot th[scope="row"] { text-align: left; font-weight: 500; white-space: nowrap; position: sticky; left: 0; background: var(--vp-c-bg); }
.bench-table td { text-align: right; white-space: nowrap; }
.bench-table tr:nth-child(2n) { background: none; }
.bench-table small { display: block; font-weight: 400; font-size: 12px; color: var(--vp-c-text-2); }
.bench-op th { text-align: left; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--cg-muted); padding-top: 18px; }
.bench-op th small { display: inline; text-transform: none; letter-spacing: 0; margin-left: 6px; }
.bench-rank { margin-right: 8px; font-size: 12px; color: var(--vp-c-text-2); }
.bench-rank.lead { color: var(--vp-c-text-1); font-weight: 600; }
.bench-rank.tie { border-bottom: 1px solid var(--vp-c-brand-1); }
.bench-mark { margin-left: 2px; }
.bench-summary th, .bench-summary td { border-top: 2px solid var(--cg-line-2); border-bottom: 0; font-weight: 600; }
.bench-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
.bench-mini { display: block; height: 3px; margin-top: 4px; background: var(--vp-c-bg-soft); border-radius: 2px; position: relative; }
.bench-mini span { position: absolute; inset: 0 auto 0 0; border-radius: 2px; }
.s1 { background: var(--cg-series-1); } .s2 { background: var(--cg-series-2); } .s3 { background: var(--cg-series-3); } .s4 { background: var(--cg-series-4); }
.bench-na { color: var(--vp-c-text-2); font-size: 13px; }
.bench-notes { font-size: 13px; color: var(--vp-c-text-2); margin: 10px 0 0; }
.bench-payloads { font-size: 13px; margin: 16px 0 0; }
.bench-code { margin-top: 20px; }
.bench-code :deep(h4) { margin: 16px 0 4px; font-size: 14px; }
.bench-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.bench-chips button { border: 1px solid var(--vp-c-divider); border-radius: 999px; padding: 3px 12px; font-size: 13px; color: var(--vp-c-text-2); }
.bench-chips button.on { border-color: var(--vp-c-brand-1); color: var(--vp-c-text-1); font-weight: 600; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
