<script setup>
import { computed, ref } from 'vue'

import { useAutoRefresh } from '../composables/use-auto-refresh'
import { dashboardState, hydrateDashboardState } from '../state/dashboard-state'
import { buildFilterOptions, buildUnifiedLogs } from '../state/logs-view-model'

const resultFilter = ref('ALL')
const sourceFilter = ref('ALL')
const interactionFilter = ref('ALL')
const placementFilter = ref('ALL')
const isLoading = computed(() => Boolean(dashboardState.meta.loading))

const { triggerRefresh: refreshLogs } = useAutoRefresh(
  () => hydrateDashboardState(),
  {
    intervalMs: 30_000,
    isBusy: () => Boolean(dashboardState.meta.loading),
  },
)

const allRows = computed(() => buildUnifiedLogs({
  decisionLogs: dashboardState.decisionLogs,
  networkFlowLogs: dashboardState.networkFlowLogs,
  placementAuditLogs: dashboardState.placementAuditLogs,
  eventLogs: dashboardState.eventLogs,
}))

const filterOptions = computed(() => buildFilterOptions(allRows.value))

const filteredLogs = computed(() => {
  return allRows.value.filter((row) => {
    const matchResult = resultFilter.value === 'ALL' || row.result === resultFilter.value
    const matchSource = sourceFilter.value === 'ALL' || row.source === sourceFilter.value
    const matchInteraction = interactionFilter.value === 'ALL' || row.kind === interactionFilter.value
    const matchPlacement = placementFilter.value === 'ALL' || row.placementId === placementFilter.value
    return matchResult && matchSource && matchInteraction && matchPlacement
  })
})

const hasRuntimeFlowLogs = computed(() => (
  Array.isArray(dashboardState.networkFlowLogs) && dashboardState.networkFlowLogs.length > 0
))

function resultPillClass(result) {
  if (result === 'served' || result === 'success' || result === 'ok') return 'status-pill good'
  if (result === 'error' || result === 'failed') return 'status-pill bad'
  return 'status-pill warn'
}
</script>

<template>
  <section class="page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Logs</p>
        <h2>Chain Logs</h2>
        <p class="subtitle">Decision + Runtime Flow + Placement Audit</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="isLoading" @click="refreshLogs">
          {{ isLoading ? 'Sync...' : 'Sync' }}
        </button>
      </div>
    </header>

    <article class="panel panel-soft">
      <div class="panel-toolbar">
        <h3>Rows</h3>
        <p class="muted">{{ filteredLogs.length }}</p>
      </div>

      <p v-if="!hasRuntimeFlowLogs" class="muted">
        当前上游未返回 runtime flow logs
      </p>

      <div class="filters">
        <label>
          Result
          <select v-model="resultFilter" class="input">
            <option v-for="option in filterOptions.results" :key="`result-${option}`" :value="option">{{ option }}</option>
          </select>
        </label>

        <label>
          Source
          <select v-model="sourceFilter" class="input">
            <option v-for="option in filterOptions.sources" :key="`source-${option}`" :value="option">{{ option }}</option>
          </select>
        </label>

        <label>
          Interaction
          <select v-model="interactionFilter" class="input">
            <option value="ALL">ALL</option>
            <option value="click">click</option>
            <option value="impression">impression</option>
            <option value="conversion">conversion</option>
            <option value="postback">postback</option>
          </select>
        </label>

        <label>
          Placement
          <select v-model="placementFilter" class="input">
            <option v-for="option in filterOptions.placements" :key="`placement-${option}`" :value="option">{{ option }}</option>
          </select>
        </label>
      </div>

      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Trace/Req ID</th>
              <th>Source</th>
              <th>Stage/Event</th>
              <th>Result/Status</th>
              <th>Interaction</th>
              <th>Link</th>
              <th>Placement</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filteredLogs" :key="`${row.source}-${row.id}-${row.timestamp}`">
              <td>{{ row.timeLabel }}</td>
              <td>{{ row.traceId }}</td>
              <td><code>{{ row.source }}</code></td>
              <td>{{ row.stage }}</td>
              <td>
                <span :class="resultPillClass(row.result)">{{ row.result }}</span>
              </td>
              <td>{{ row.kind || '-' }}</td>
              <td>
                <a v-if="row.linkUrl && row.linkUrl !== '-'" :href="row.linkUrl" target="_blank" rel="noopener noreferrer">
                  {{ row.linkUrl }}
                </a>
                <span v-else>-</span>
              </td>
              <td>{{ row.placementId }}</td>
              <td>{{ row.detail }}</td>
            </tr>
            <tr v-if="filteredLogs.length === 0">
              <td colspan="9" class="muted">No chain logs.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </section>
</template>
