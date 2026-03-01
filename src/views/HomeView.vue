<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

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

const revenueCards = computed(() => {
  const row = totals.value
  const revenue = Number(row.settledRevenueUsd || 0)
  const requests = Number(row.requests || 0)
  const conversions = Number(row.settledConversions || 0)
  const fillRate = Number(row.fillRate || 0)

  const runtimeErrors = Number(networkFlowStats.value.runtimeErrors || 0)
  const runtimeEvaluations = Number(networkFlowStats.value.totalRuntimeEvaluations || 0)
  const runtimeErrorRate = runtimeEvaluations > 0
    ? runtimeErrors / runtimeEvaluations
    : Number.NaN

  return [
    { label: 'Revenue', value: `$${revenue.toFixed(2)}` },
    { label: 'Requests', value: requests.toLocaleString() },
    { label: 'Conversions', value: conversions.toLocaleString() },
    { label: 'Fill Rate', value: formatPercent(fillRate) },
    { label: 'Runtime Error Rate', value: formatPercent(runtimeErrorRate) },
  ]
})

const coreActions = [
  { to: '/onboarding', title: 'Integrate (3 min)' },
  { to: '/logs', title: 'Open Chain Logs' },
]

const { triggerRefresh: refreshRevenue } = useAutoRefresh(
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
        <p class="eyebrow">Revenue</p>
        <h2>Key Metrics</h2>
        <p class="subtitle">{{ lastSyncedLabel }}</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="isLoading" @click="refreshRevenue">
          {{ isLoading ? 'Sync...' : 'Sync' }}
        </button>
      </div>
    </header>

    <div class="kpi-grid minimal-kpi-grid">
      <article v-for="item in revenueCards" :key="item.label" class="kpi-card">
        <p class="kpi-label">{{ item.label }}</p>
        <p class="kpi-value">{{ item.value }}</p>
      </article>
    </div>

    <article class="panel panel-soft">
      <div class="panel-toolbar">
        <h3>Core Actions</h3>
      </div>
      <div class="rail-actions">
        <RouterLink
          v-for="item in coreActions"
          :key="item.to"
          :to="item.to"
          class="rail-action-link"
        >
          <strong>{{ item.title }}</strong>
          <span class="quick-link-arrow">-&gt;</span>
        </RouterLink>
      </div>
    </article>
  </section>
</template>
