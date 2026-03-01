<script setup>
import { computed } from 'vue'

import { useAutoRefresh } from '../composables/use-auto-refresh'
import { dashboardState, hydrateDashboardState } from '../state/dashboard-state'

const isLoading = computed(() => Boolean(dashboardState.meta?.loading))
const totals = computed(() => dashboardState.settlementAggregates?.totals || {})
const networkFlowStats = computed(() => dashboardState.networkFlowStats || {})

const lastSyncedLabel = computed(() => {
  const raw = dashboardState.meta?.lastSyncedAt
  if (!raw) return 'Not synced'
  const value = new Date(raw)
  if (Number.isNaN(value.getTime())) return 'Not synced'
  return value.toLocaleString()
})

function formatPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  return `${(numeric * 100).toFixed(2)}%`
}

const overviewCards = computed(() => {
  const row = totals.value
  const revenue = Number(row.settledRevenueUsd || 0)
  const requests = Number(row.requests || 0)
  const fillRate = Number(row.fillRate || 0)
  const errors = Number(networkFlowStats.value.runtimeErrors || 0)

  return [
    { label: 'Revenue', value: `$${revenue.toFixed(2)}` },
    { label: 'Requests', value: requests.toLocaleString() },
    { label: 'Fill Rate', value: formatPercent(fillRate) },
    { label: 'Errors', value: errors.toLocaleString() },
  ]
})

const statusLine = computed(() => {
  const source = dashboardState.meta.connected ? 'Connected' : 'Unavailable'
  const error = String(dashboardState.meta.error || '').trim()
  return error ? `${source} · ${error}` : source
})

const { triggerRefresh: refreshOverview } = useAutoRefresh(
  () => hydrateDashboardState(),
  {
    intervalMs: 30_000,
    isBusy: () => Boolean(dashboardState.meta?.loading),
  },
)
</script>

<template>
  <section class="page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Overview</p>
        <h2>Overview</h2>
        <p class="subtitle">{{ lastSyncedLabel }}</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="isLoading" @click="refreshOverview">
          {{ isLoading ? 'Sync...' : 'Sync' }}
        </button>
      </div>
    </header>

    <article class="panel panel-soft">
      <p class="muted">{{ statusLine }}</p>
    </article>

    <div class="kpi-grid minimal-kpi-grid">
      <article v-for="item in overviewCards" :key="item.label" class="kpi-card">
        <p class="kpi-label">{{ item.label }}</p>
        <p class="kpi-value">{{ item.value }}</p>
      </article>
    </div>
  </section>
</template>
