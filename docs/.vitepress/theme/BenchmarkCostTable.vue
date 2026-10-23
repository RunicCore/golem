<script setup lang="ts">
import { computed } from 'vue';
import type { BenchmarkSiteProjection, CostCells } from '../../../scripts/benchmark/site-projection.js';

const props = defineProps<{ blocks: BenchmarkSiteProjection['cost'] }>();

const exact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// The cells and ratios come from the one function that the console cost table uses (scripts/benchmark/tables.ts); the page only draws them.
type CostColumn = { readonly key: keyof CostCells; readonly label: string };
/** The column groups of the table, left to right. */
const columnGroups: readonly { readonly title: string; readonly columns: readonly CostColumn[] }[] = [
  { title: 'IModel: validation', columns: [{ key: 'imodelOff', label: 'off' }, { key: 'imodelOn', label: 'on' }, { key: 'imodelOnOverOff', label: 'on/off' }] },
  { title: 'IObject: validation', columns: [{ key: 'iobjectOff', label: 'off' }, { key: 'iobjectOn', label: 'on' }, { key: 'iobjectOnOverOff', label: 'on/off' }] },
  { title: 'Other pairs, validation on', columns: [
    { key: 'imodelOverIobject', label: 'IModel/IObject' }, { key: 'serdeManyOverNone', label: 'serde many/none' },
    { key: 'invalidOverValid', label: 'invalid/valid' },
  ] },
];
const columns = columnGroups.flatMap(g => g.columns);
/** The cells of each row in column order. */
const tables = computed(() => props.blocks.map(block => ({ ...block, rows: block.rows.map(row => ({ operation: row.operation, cells: columns.map(column => row.cells[column.key]) })) })));
</script>

<template>
  <div class="cost">
    <div class="cost-frame" role="region" tabindex="0" aria-label="What each feature costs">
      <table class="cost-table">
        <thead>
          <tr>
            <th rowspan="2" scope="col" class="cost-first">Payload and operation</th>
            <th v-for="group in columnGroups" :key="group.title" :colspan="group.columns.length" scope="colgroup" class="cost-group">{{ group.title }}</th>
          </tr>
          <tr>
            <th v-for="column in columns" :key="column.key" scope="col">{{ column.label }}</th>
          </tr>
        </thead>
        <tbody v-for="block in tables" :key="block.payload.id">
          <tr class="cost-payload"><th :colspan="columns.length + 1" scope="rowgroup" :title="block.payload.description">{{ block.payload.label }}</th></tr>
          <tr v-for="item in block.rows" :key="item.operation.id">
            <th scope="row">{{ item.operation.label }}</th>
            <td v-for="(cell, index) in item.cells" :key="columns[index].key" :class="{ ratio: cell.kind === 'ratio' }">
              <template v-if="cell.kind === 'ops'">{{ exact.format(cell.value) }}</template>
              <template v-else-if="cell.kind === 'ratio'">{{ cell.value.toFixed(2) }}x</template>
              <template v-else-if="cell.kind === 'not-applicable'"><span aria-hidden="true">—</span><span class="visually-hidden">does not apply</span></template>
              <span v-else class="cost-na">not run</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ul class="cost-notes">
      <li>Off and on show operations per second. A ratio column shows one speed divided by another.</li>
      <li><strong>IModel:</strong> on/off divides the speed with validation on by the speed with validation off. Off is a build with validation off. Validate has no off mode.</li>
      <li><strong>IObject:</strong> on/off divides the same way, for the plain-object codec.</li>
      <li><strong>Other pairs:</strong> IModel/IObject divides the IModel speed by the IObject speed. Serde many/none divides serde-many by serde-none for the same operation. Invalid/valid divides the speed on one broken value by the speed on a valid value, for parse, decode and validate.</li>
      <li>A dash (—) means the pair does not apply. A run that did not time a pair shows "not run".</li>
      <li>This table has no release column. To compare this checkout with an earlier one, run <code>npm run bench:release -- --base &lt;git ref&gt;</code>.</li>
    </ul>
  </div>
</template>

<style scoped>
/* The table scrolls inside its own frame, so the page never scrolls sideways. */
.cost-frame { position: relative; overflow-x: auto; max-width: 100%; margin: 8px 0 0; }
.cost-frame:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.cost-table { display: table; width: 100%; min-width: 960px; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 14px; margin: 0; }
.cost-table th, .cost-table td { border: 0; border-bottom: 1px solid var(--vp-c-divider); padding: 8px 10px; background: none; }
.cost-table tr:nth-child(2n) { background: none; }
.cost-table thead th { color: var(--vp-c-text-2); font-weight: 500; font-size: 13px; text-align: right; vertical-align: bottom; white-space: nowrap; }
.cost-table thead th.cost-first { text-align: left; }
.cost-table thead th.cost-group { text-align: center; color: var(--vp-c-text-1); border-bottom-color: var(--cg-line-2); }
.cost-table tbody th[scope="row"] { text-align: left; font-weight: 500; white-space: nowrap; position: sticky; left: 0; background: var(--vp-c-bg); }
.cost-table td { text-align: right; white-space: nowrap; }
.cost-table td.ratio { font-weight: 600; }
.cost-payload th { text-align: left; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--cg-muted); padding-top: 18px; }
.cost-na { color: var(--vp-c-text-2); font-size: 13px; }
.cost-notes { font-size: 13px; color: var(--vp-c-text-2); margin: 10px 0 0; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
