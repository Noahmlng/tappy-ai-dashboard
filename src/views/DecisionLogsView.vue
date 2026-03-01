<script setup>
import { computed, ref } from 'vue'

import { useAutoRefresh } from '../composables/use-auto-refresh'
import { dashboardState, hydrateDashboardState } from '../state/dashboard-state'
import { buildFilterOptions, buildUnifiedLogs } from '../state/logs-view-model'

const interactionFilter = ref('click')
const placementFilter = ref('ALL')
const resultFilter = ref('ALL')
const showAllEvents = ref(false)

const isLoading = computed(() => Boolean(dashboardState.meta.loading))

const { triggerRefresh: refreshLogs } = useAutoRefresh(
  () => hydrateDashboardState(),
  {
    intervalMs: 30_000,
    isBusy: () => Boolean(dashboardState.meta.loading),
  },
)

const chainRows = computed(() => buildUnifiedLogs({
  eventLogs: dashboardState.eventLogs,
  decisionLogs: dashboardState.decisionLogs,
  placementAuditLogs: dashboardState.placementAuditLogs,
}))

const filterOptions = computed(() => buildFilterOptions(chainRows.value))

const filteredRows = computed(() => {
  return chainRows.value.filter((row) => {
    const matchInteraction = showAllEvents.value
      ? true
      : (interactionFilter.value === 'ALL' || row.kind === interactionFilter.value)
    const matchPlacement = placementFilter.value === 'ALL' || row.placementId === placementFilter.value
    const matchResult = resultFilter.value === 'ALL' || row.result === resultFilter.value
    return matchInteraction && matchPlacement && matchResult
  })
})

function formatRevenue(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return '-'
  return `$${numeric.toFixed(2)}`
}
</script>

<template>
  <section class="page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Chains</p>
        <h2>Interaction Chains</h2>
        <p class="subtitle">Click-focused chain view for output links</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="isLoading" @click="refreshLogs">
          {{ isLoading ? 'Sync...' : 'Sync' }}
        </button>
      </div>
    </header>

    <article class="panel panel-soft">
      <div class="panel-toolbar">
        <h3>Chains</h3>
        <p class="muted">{{ filteredRows.length }}</p>
      </div>

      <div class="toolbar-actions">
        <button class="button button-secondary" type="button" @click="showAllEvents = !showAllEvents">
          {{ showAllEvents ? 'Click-only View' : 'Show All Events' }}
        </button>
      </div>

      <div class="filters">
        <label>
          Interaction
          <select v-model="interactionFilter" class="input" :disabled="showAllEvents">
            <option v-for="option in filterOptions.interactions" :key="`interaction-${option}`" :value="option">{{ option }}</option>
          </select>
        </label>

        <label>
          Placement
          <select v-model="placementFilter" class="input">
            <option v-for="option in filterOptions.placements" :key="`placement-${option}`" :value="option">{{ option }}</option>
          </select>
        </label>

        <label>
          Result
          <select v-model="resultFilter" class="input">
            <option v-for="option in filterOptions.results" :key="`result-${option}`" :value="option">{{ option }}</option>
          </select>
        </label>
      </div>

      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Request ID</th>
              <th>Placement</th>
              <th>Clicked Link</th>
              <th>Click Status</th>
              <th>Postback Status</th>
              <th>Revenue</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filteredRows" :key="row.id">
              <td>{{ row.timeLabel }}</td>
              <td>{{ row.requestId }}</td>
              <td>{{ row.placementId }}</td>
              <td>
                <a
                  v-if="row.clickedLink && row.clickedLink !== '-'"
                  :href="row.clickedLink"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ row.clickedLink }}
                </a>
                <span v-else>-</span>
              </td>
              <td>{{ row.clickStatus || '-' }}</td>
              <td>{{ row.postbackStatus || '-' }}</td>
              <td>{{ formatRevenue(row.revenue) }}</td>
            </tr>
            <tr v-if="filteredRows.length === 0">
              <td colspan="7" class="muted">No interaction chains.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </section>
</template>
