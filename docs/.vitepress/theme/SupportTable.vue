<script setup lang="ts">
import { ref } from 'vue';
import type {
  SupportProjection,
  SupportProjectionProfile,
  SupportProjectionRecord,
} from '../../../scripts/support-projection.js';

type OpenApiVersion = SupportProjection['versions'][number];
type GenerationProfileId = SupportProjectionProfile['id'];

declare const __GOLEM_SUPPORT_PROJECTION__: SupportProjection;

const metadata = __GOLEM_SUPPORT_PROJECTION__;
const profileIds = metadata.profiles.map((profile) => profile.id);
const version = ref<OpenApiVersion>('3.1');
const profile = ref<GenerationProfileId>('profile-2');
const query = ref('');

function profileName(id: GenerationProfileId): string {
  return metadata.profiles.find((item) => item.id === id)?.label ?? id;
}

function visible(record: SupportProjectionRecord): boolean {
  const needle = query.value.trim().toLowerCase();
  return record.version === version.value && record.profile === profile.value
    && `${record.title} ${record.limitations.join(' ')}`.toLowerCase().includes(needle);
}
</script>

<template>
  <div>
    <div class="support-controls">
      <label>OpenAPI version
        <select v-model="version">
          <option v-for="item in metadata.versions" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <label>Generation settings
        <select v-model="profile">
          <option v-for="id in profileIds" :key="id" :value="id">{{ profileName(id) }}</option>
        </select>
      </label>
      <label>Find a feature
        <input v-model="query" type="search" placeholder="For example, streams" />
      </label>
    </div>
    <div class="support-table-wrap">
      <table class="support-table" data-support-table>
        <thead><tr><th>Feature</th><th>Support</th><th>What to expect</th></tr></thead>
        <tbody>
          <tr v-for="record in metadata.capabilities" v-show="visible(record)"
            :key="record.key" :data-support-row="record.key">
            <td><strong>{{ record.title }}</strong><small>{{ record.surface }}</small></td>
            <td :data-support-key="record.key" :data-status="record.statusLabel">
              <span class="support-status" :data-kind="record.status">{{ record.statusLabel }}</span>
            </td>
            <td><ul class="support-limits"><li v-for="limit in record.limitations" :key="limit">{{ limit }}</li></ul></td>
          </tr>
        </tbody>
      </table>
      <p v-if="!metadata.capabilities.some(visible)" role="status">No features match your search.</p>
    </div>
    <details>
      <summary>What the support labels mean</summary>
      <ul><li v-for="item in metadata.statuses" :key="item.id"><strong>{{ item.label }}</strong>: {{ item.meaning }}.</li></ul>
    </details>
    <slot name="type-system-limits" />
    <ul><li v-for="boundary in metadata.representationBoundaries" :key="boundary">{{ boundary }}</li></ul>
  </div>
</template>
