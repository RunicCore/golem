<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import raw from '../../public/benchmarks/results.json';
import { isBenchmarkResults, type ResultCase } from '../../../scripts/benchmark/results-schema.js';
import { GROUPS } from '../../../scripts/benchmark/cases.js';

const data = isBenchmarkResults(raw) ? raw : undefined;
// An empty placeholder means nothing is published yet; anything else that fails the check is a broken file.
const published = typeof raw === 'object' && raw !== null && Object.keys(raw).length > 0;
const exact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

const groups = data?.groups ?? [];
const payloads = data?.payloads ?? [];
const groupId = ref(groups[0]?.id ?? '');
const payloadId = ref(payloads[0]?.id ?? '');
const codePayloadId = ref(payloads[0]?.id ?? '');
/** What an operation does in the selected group; falls back to the generic description. */
const operationText = (operation: { id: string; description: string }): string =>
  GROUPS.find(g => g.id === groupId.value)?.operationDescriptions[operation.id as 'parse'] ?? operation.description;
const tabs = ref<HTMLButtonElement[]>([]);

const adapterLabel = (id: string) => data?.adapters.find(a => a.id === id)?.label ?? id;
const adapterUrl = (id: string) => data?.adapters.find(a => a.id === id)?.sourceUrl;
const bytes = (value: number) => value >= 1024 ? `${exact.format(Math.round(value / 1024))} KB` : `${value} B`;
const find = (payload: string, operation: string, adapter: string): ResultCase | undefined =>
  data?.cases.find(c => c.payload === payload && c.operation === operation && c.adapter === adapter);

/** One block per operation the selected group runs; one row per library, in the group's order. */
const blocks = computed(() => {
  const members = (data?.adapters ?? []).filter(a => a.group === groupId.value);
  return (data?.operations ?? []).flatMap(operation => {
    const rows = members.filter(a => payloads.some(p => find(p.id, operation.id, a.id)));
    if (rows.length === 0) return [];
    const scale = (payload: string) => Math.max(1, ...rows.map(a => find(payload, operation.id, a.id)?.opsPerSec?.median ?? 0));
    return [{
      operation,
      rows: rows.map((adapter, index) => ({
        adapter,
        series: `s${(members.indexOf(adapter) % 4) + 1}`,
        cells: payloads.map(p => {
          const found = find(p.id, operation.id, adapter.id);
          const median = found?.opsPerSec?.median;
          return { payload: p.id, median, note: found?.note, share: median === undefined ? 0 : median / scale(p.id) };
        }),
      })),
    }];
  });
});

/** Why a library cannot run a case, once per library and note. */
const notes = computed(() => {
  const seen = new Map<string, string>();
  for (const block of blocks.value) for (const row of block.rows) for (const cell of row.cells) {
    if (cell.note && cell.median === undefined) {
      const payload = payloads.find(p => p.id === cell.payload)?.label ?? cell.payload;
      seen.set(`${row.adapter.id}\0${cell.payload}`, `${row.adapter.label} on ${payload}: ${cell.note}`);
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

// Tabs follow the WAI-ARIA pattern: arrow keys, Home and End move between groups.
async function onTabKey(event: KeyboardEvent, index: number): Promise<void> {
  const last = groups.length - 1;
  const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
    : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
  if (next === undefined) return;
  event.preventDefault();
  groupId.value = groups[next].id;
  await nextTick();
  tabs.value[next]?.focus();
}
</script>

<template>
  <div v-if="data" class="bench">
    <p class="bench-meta">{{ measuredOn }}</p>
    <div class="bench-tabs" role="tablist" aria-label="Comparison group">
      <button v-for="(group, index) in groups" :id="`bench-tab-${group.id}`" :key="group.id" ref="tabs" role="tab" type="button"
        :aria-selected="group.id === groupId" aria-controls="bench-panel" :tabindex="group.id === groupId ? 0 : -1"
        :class="{ on: group.id === groupId }" @click="groupId = group.id" @keydown="onTabKey($event, index)">{{ group.label }}</button>
    </div>
    <section id="bench-panel" role="tabpanel" :aria-labelledby="`bench-tab-${groupId}`" class="bench-panel">
    <div v-for="group in groups" v-show="group.id === groupId" :key="group.id" class="bench-explain"><slot :name="group.id">{{ group.description }}</slot></div>

    <table class="bench-table">
      <thead>
        <tr><th scope="col"><span class="visually-hidden">Library</span></th>
          <th v-for="p in payloads" :key="p.id" scope="col">{{ p.label }}<small>{{ bytes(p.bytes) }}</small></th></tr>
      </thead>
      <tbody v-for="block in blocks" :key="block.operation.id">
        <tr class="bench-op"><th :colspan="payloads.length + 1" scope="rowgroup">{{ block.operation.label }} <small>{{ operationText(block.operation) }}</small></th></tr>
        <tr v-for="row in block.rows" :key="row.adapter.id">
          <th scope="row"><span class="bench-dot" :class="row.series" aria-hidden="true" /><a :href="adapterUrl(row.adapter.id)">{{ row.adapter.label }}</a></th>
          <td v-for="cell in row.cells" :key="cell.payload">
            <template v-if="cell.median !== undefined">
              {{ exact.format(cell.median) }}<span class="bench-mini"><span :class="row.series" :style="{ width: `${cell.share * 100}%` }" /></span>
            </template>
            <span v-else-if="cell.note" class="bench-na" :title="cell.note">not supported</span>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="bench-picker">
      <div class="bench-chips" role="group" aria-label="Payload">
        <button v-for="p in payloads" :key="p.id" type="button" :aria-pressed="p.id === payloadId" :class="{ on: p.id === payloadId }"
          @click="payloadId = p.id">{{ p.label }}</button>
      </div>
      <div v-for="block in blocks" :key="block.operation.id" class="bench-phone-op">
        <h4>{{ block.operation.label }} <small>{{ operationText(block.operation) }}</small></h4>
        <template v-for="row in block.rows" :key="row.adapter.id">
          <template v-for="cell in row.cells.filter(c => c.payload === payloadId)" :key="cell.payload">
            <div v-if="cell.median !== undefined" class="bench-phone-row">
              <span class="bench-phone-name">{{ row.adapter.label }}</span>
              <span class="bench-track"><span :class="row.series" :style="{ width: `${cell.share * 100}%` }" /></span>
              <span class="bench-phone-value">{{ compact.format(cell.median) }}</span>
            </div>
            <p v-else-if="cell.note" class="bench-na">{{ row.adapter.label }}: not supported</p>
          </template>
        </template>
      </div>
    </div>

    <ul v-if="notes.length" class="bench-notes"><li v-for="note in notes" :key="note">{{ note }}</li></ul>
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
  <p v-else-if="published" class="bench-missing">The published results file is not a valid results file. Run <code>npm run bench</code> to replace it.</p>
  <p v-else class="bench-missing">No benchmark results are published yet. Run <code>npm run bench</code>.</p>
</template>

<style scoped>
.bench-meta { color: var(--vp-c-text-2); font-size: 13px; margin: 8px 0 16px; }
.bench-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--vp-c-divider); }
.bench-tabs button { padding: 8px 12px; margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--vp-c-text-2); font-size: 14px; }
.bench-tabs button.on { color: var(--vp-c-text-1); border-color: var(--vp-c-brand-1); font-weight: 600; }
.bench-tabs button:focus-visible, .bench-chips button:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.bench-explain { font-size: 14px; margin: 12px 0 8px; }
.bench-explain :deep(p) { margin: 0; }
.bench-table { display: table; width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 14px; margin: 8px 0 0; }
.bench-table th, .bench-table td { border: 0; border-bottom: 1px solid var(--vp-c-divider); padding: 8px 10px; background: none; }
.bench-table thead th { color: var(--vp-c-text-2); font-weight: 500; font-size: 13px; text-align: right; }
.bench-table thead th small { display: block; font-weight: 400; font-size: 12px; }
.bench-table tbody th[scope="row"] { text-align: left; font-weight: 500; white-space: nowrap; }
.bench-table tbody th[scope="row"] a { color: inherit; text-decoration: underline dotted; text-underline-offset: 3px; }
.bench-table td { text-align: right; }
.bench-table tr:nth-child(2n) { background: none; }
.bench-op th small, .bench-phone-op h4 small { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 6px; }
.bench-op th { text-align: left; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--cg-muted); padding-top: 18px; }
.bench-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
.bench-mini { display: block; height: 3px; margin-top: 4px; background: var(--vp-c-bg-soft); border-radius: 2px; position: relative; }
.bench-mini span, .bench-track span { position: absolute; inset: 0 auto 0 0; border-radius: 2px; }
.s1 { background: var(--cg-series-1); } .s2 { background: var(--cg-series-2); } .s3 { background: var(--cg-series-3); } .s4 { background: var(--cg-series-4); }
.bench-na { color: var(--vp-c-text-2); font-size: 13px; }
.bench-notes { font-size: 13px; color: var(--vp-c-text-2); margin: 10px 0 0; }
.bench-payloads { font-size: 13px; margin: 16px 0 0; }
.bench-code { margin-top: 20px; }
.bench-code :deep(h4) { margin: 16px 0 4px; font-size: 14px; }
.bench-picker { display: none; }
.bench-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.bench-chips button { border: 1px solid var(--vp-c-divider); border-radius: 999px; padding: 3px 12px; font-size: 13px; color: var(--vp-c-text-2); }
.bench-chips button.on { border-color: var(--vp-c-brand-1); color: var(--vp-c-text-1); font-weight: 600; }
.bench-phone-op h4 { margin: 14px 0 6px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--cg-muted); }
.bench-phone-row { display: grid; grid-template-columns: 8.5rem 1fr 3.5rem; gap: 8px; align-items: center; margin: 6px 0; font-size: 13px; }
.bench-phone-name { overflow-wrap: anywhere; }
.bench-track { height: 8px; background: var(--vp-c-bg-soft); border-radius: 2px; position: relative; }
.bench-phone-value { text-align: right; font-variant-numeric: tabular-nums; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 640px) {
  .bench-table { display: none; }
  .bench-picker { display: block; }
}
</style>
