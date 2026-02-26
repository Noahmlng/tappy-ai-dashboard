<script setup>
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'

import { dashboardState, hydrateDashboardState } from '../state/dashboard-state'

const isLoading = computed(() => Boolean(dashboardState.meta?.loading))

const totals = computed(() => dashboardState.settlementAggregates?.totals || {})
const reasonRatios = computed(() => {
  const fromTotals = totals.value?.reasonRatios
  if (fromTotals && typeof fromTotals === 'object') return fromTotals

  const fromSettlement = dashboardState.settlementAggregates?.reasonRatios
  if (fromSettlement && typeof fromSettlement === 'object') return fromSettlement

  return {}
})

function formatRatioPercent(value) {
  const numeric = Number(value || 0)
  return `${(numeric * 100).toFixed(2)}%`
}
const lastSyncedLabel = computed(() => {
  const raw = dashboardState.meta?.lastSyncedAt
  if (!raw) return 'Not synced'
  const value = new Date(raw)
  if (Number.isNaN(value.getTime())) return 'Not synced'
  return value.toLocaleString()
})

const revenueCards = computed(() => {
  const row = totals.value
  const revenue = Number(row.settledRevenueUsd || 0)
  const requests = Number(row.requests || 0)
  const conversions = Number(row.settledConversions || 0)

  return [
    { label: 'Revenue', value: `$${revenue.toFixed(2)}` },
    { label: 'Requests', value: requests.toLocaleString() },
    { label: 'Conversions', value: conversions.toLocaleString() },
    {
      label: 'placement_unavailable',
      value: formatRatioPercent(reasonRatios.value.placement_unavailable),
    },
    {
      label: 'inventory_empty',
      value: formatRatioPercent(reasonRatios.value.inventory_empty),
    },
    {
      label: 'scope_violation',
      value: formatRatioPercent(reasonRatios.value.scope_violation),
    },
  ]
})

const coreActions = [
  { to: '/onboarding', title: 'Integrate (3 min)' },
  { to: '/logs', title: 'Logs' },
]

function refreshRevenue() {
  hydrateDashboardState()
}

onMounted(() => {
  refreshRevenue()
})
</script>

<template>
  <section class="page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Revenue</p>
        <h2>Revenue</h2>
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
        <h3>Core</h3>
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
