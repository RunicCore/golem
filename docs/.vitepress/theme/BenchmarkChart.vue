<script setup lang="ts">
import { nextTick, ref } from 'vue';
import type { BenchmarkSiteProjection } from '../../../scripts/benchmark/site-projection.js';
import BenchmarkCostTable from './BenchmarkCostTable.vue';

declare const __GOLEM_BENCHMARK_PROJECTION__: BenchmarkSiteProjection;

// Only the golem projection reaches the bundle (scripts/benchmark/site-projection.ts); the full results file stays internal.
const data = __GOLEM_BENCHMARK_PROJECTION__;
const exact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const bytes = (value: number) => value >= 1024 ? `${exact.format(Math.round(value / 1024))} KB` : `${value} B`;

const codePayloadId = ref(data.speeds[0]?.payload.id ?? '');
const views = [{ id: 'speed', label: 'Speed per payload' }, { id: 'cost', label: 'What each feature costs' }] as const;
const viewId = ref<(typeof views)[number]['id']>('speed');
const viewTabs = ref<HTMLButtonElement[]>([]);

/** One block for each payload, one row for each operation; a bar shows a cell against the fastest cell of its row. */
const blocks = data.speeds.map(({ payload, rows }) => ({
  payload,
  rows: rows.map(row => {
    const leader = Math.max(...row.cells.flatMap(cell => cell === null ? [] : [cell]));
    return { operation: row.operation, cells: row.cells.map(cell => cell === null ? null : { value: cell, share: cell / leader }) };
  }),
}));

// Tabs follow the WAI-ARIA pattern: arrow keys, Home and End move between the tabs of one list.
async function onViewKey(event: KeyboardEvent, index: number): Promise<void> {
  const last = views.length - 1;
  const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
    : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
  if (next === undefined) return;
  event.preventDefault();
  viewId.value = views[next].id;
  await nextTick();
  viewTabs.value[next]?.focus();
}
</script>

<template>
  <div class="bench">
    <p class="bench-meta">{{ data.measured }}</p>
    <div class="bench-views" role="tablist" aria-label="Table">
      <button v-for="(view, index) in views" :id="`bench-view-${view.id}`" :key="view.id" ref="viewTabs" role="tab" type="button"
        :aria-selected="view.id === viewId" :aria-controls="`bench-view-panel-${view.id}`" :tabindex="view.id === viewId ? 0 : -1"
        :class="{ on: view.id === viewId }" @click="viewId = view.id" @keydown="onViewKey($event, index)">{{ view.label }}</button>
    </div>
    <div id="bench-view-panel-speed" v-show="viewId === 'speed'" role="tabpanel" aria-labelledby="bench-view-speed">
      <div class="bench-explain"><slot name="speed" /></div>
      <div class="bench-frame" role="region" tabindex="0" aria-label="Golem speeds">
        <table class="bench-table">
          <thead>
            <tr><th scope="col">Payload and operation</th>
              <th v-for="column in data.columns" :key="column.id" scope="col"><span class="bench-dot" :class="column.series" aria-hidden="true" /><a :href="column.sourceUrl">{{ column.label }}</a></th></tr>
          </thead>
          <tbody v-for="block in blocks" :key="block.payload.id">
            <tr class="bench-op"><th :colspan="data.columns.length + 1" scope="rowgroup">{{ block.payload.label }} <small>{{ bytes(block.payload.bytes) }}</small></th></tr>
            <tr v-for="row in block.rows" :key="row.operation.id">
              <th scope="row">{{ row.operation.label }}</th>
              <td v-for="(cell, index) in row.cells" :key="data.columns[index].id">
                <template v-if="cell">
                  <span class="bench-ops">{{ exact.format(cell.value) }}</span>
                  <span class="bench-mini"><span :class="data.columns[index].series" :style="{ width: `${cell.share * 100}%` }" /></span>
                </template>
                <span v-else class="bench-na"><span aria-hidden="true">—</span><span class="visually-hidden">does not apply</span></span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul class="bench-notes">
        <li>Each number is operations per second. The bar under it shows the number against the fastest setup in its row.</li>
        <li>A dash (—) means the setup has no such operation.</li>
      </ul>
      <div class="bench-code">
        <h4>Code</h4>
        <div class="bench-chips" role="group" aria-label="Payload for the code">
          <button v-for="{ payload } in data.speeds" :key="payload.id" type="button" :aria-pressed="payload.id === codePayloadId" :class="{ on: payload.id === codePayloadId }"
            @click="codePayloadId = payload.id">{{ payload.label }}</button>
        </div>
        <div v-for="{ payload } in data.speeds" v-show="payload.id === codePayloadId" :key="payload.id">
          <slot :name="`${payload.id}-code`" />
        </div>
      </div>
      <ul class="bench-payloads">
        <li v-for="{ payload } in data.speeds" :key="payload.id"><strong>{{ payload.label }}</strong> ({{ bytes(payload.bytes) }}): {{ payload.description }} <a :href="payload.sourceUrl">Source</a></li>
      </ul>
    </div>
    <div id="bench-view-panel-cost" v-show="viewId === 'cost'" role="tabpanel" aria-labelledby="bench-view-cost">
      <BenchmarkCostTable :blocks="data.cost" />
    </div>
  </div>
</template>

<style scoped>
.bench-meta { color: var(--vp-c-text-2); font-size: 13px; margin: 8px 0 16px; }
.bench-views { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.bench-views button { border: 1px solid var(--vp-c-divider); border-radius: 6px; padding: 6px 14px; font-size: 14px; color: var(--vp-c-text-2); }
.bench-views button.on { border-color: var(--vp-c-brand-1); color: var(--vp-c-text-1); font-weight: 600; }
.bench-views button:focus-visible, .bench-chips button:focus-visible, .bench-frame:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.bench-explain { font-size: 14px; margin: 12px 0 8px; }
.bench-explain :deep(p) { margin: 0; }
/* The table scrolls inside its own frame, so the page never scrolls sideways. */
.bench-frame { position: relative; overflow-x: auto; max-width: 100%; margin: 8px 0 0; }
.bench-table { display: table; width: 100%; min-width: 640px; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 14px; margin: 0; }
.bench-table th, .bench-table td { border: 0; border-bottom: 1px solid var(--vp-c-divider); padding: 8px 10px; background: none; }
.bench-table thead th { color: var(--vp-c-text-2); font-weight: 500; font-size: 13px; text-align: right; vertical-align: bottom; }
.bench-table thead th:first-child { text-align: left; }
.bench-table thead th a { color: inherit; text-decoration: underline dotted; text-underline-offset: 3px; }
.bench-table tbody th[scope="row"] { text-align: left; font-weight: 500; white-space: nowrap; position: sticky; left: 0; background: var(--vp-c-bg); }
.bench-table td { text-align: right; white-space: nowrap; }
.bench-table tr:nth-child(2n) { background: none; }
.bench-table small { display: block; font-weight: 400; font-size: 12px; color: var(--vp-c-text-2); }
.bench-op th { text-align: left; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--cg-muted); padding-top: 18px; }
.bench-op th small { display: inline; text-transform: none; letter-spacing: 0; margin-left: 6px; }
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
