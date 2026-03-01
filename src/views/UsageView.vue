<script setup>
import { computed } from 'vue'

import { useAutoRefresh } from '../composables/use-auto-refresh'
import { dashboardState, hydrateDashboardState } from '../state/dashboard-state'
import { scopeState } from '../state/scope-state'

const isLoading = computed(() => Boolean(dashboardState.meta.loading))
const scopeLabel = computed(() => `account=${scopeState.accountId || '-'} · app=${scopeState.appId || '-'}`)

const dailyRows = computed(() => {
  const list = Array.isArray(dashboardState.metricsByDay) ? dashboardState.metricsByDay : []
  return list.map((row) => {
    const requests = Number(row.requests ?? row.impressions ?? 0)
    const conversions = Number(row.settledConversions ?? row.conversions ?? row.clicks ?? 0)
    const revenueUsd = Number(row.settledRevenueUsd ?? row.revenueUsd ?? 0)

    return {
      day: String(row.day || '-'),
      requests,
      conversions,
      revenueUsd,
    }
  })
})

const summaryCards = computed(() => {
  const totals = dailyRows.value.reduce((acc, row) => {
    acc.requests += row.requests
    acc.conversions += row.conversions
    acc.revenueUsd += row.revenueUsd
    return acc
  }, {
    requests: 0,
    conversions: 0,
    revenueUsd: 0,
  })

  return [
    {
      label: '7D Requests',
      value: totals.requests.toLocaleString(),
    },
    {
      label: '7D Conversions',
      value: totals.conversions.toLocaleString(),
    },
    {
      label: '7D Revenue',
      value: `$${totals.revenueUsd.toFixed(2)}`,
    },
  ]
})

const { triggerRefresh: refreshUsage } = useAutoRefresh(
  () => hydrateDashboardState(),
  {
    intervalMs: 30_000,
    isBusy: () => Boolean(dashboardState.meta.loading),
  },
)
</script>

<template>
  <section class="page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Usage</p>
        <h2>Usage & Revenue</h2>
        <p class="subtitle">{{ scopeLabel }}</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="isLoading" @click="refreshUsage">
          {{ isLoading ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>
    </header>

    <article class="panel panel-soft">
      <p class="muted">
        Source:
        <strong>{{ dashboardState.meta.connected ? 'public API' : 'unavailable' }}</strong>
        <span v-if="dashboardState.meta.lastSyncedAt">
          · last synced {{ new Date(dashboardState.meta.lastSyncedAt).toLocaleString() }}
        </span>
      </p>
      <p v-if="dashboardState.meta.error" class="muted">
        {{ dashboardState.meta.error }}
      </p>
    </article>

    <div class="kpi-grid minimal-kpi-grid">
      <article v-for="card in summaryCards" :key="card.label" class="kpi-card">
        <p class="kpi-label">{{ card.label }}</p>
        <p class="kpi-value">{{ card.value }}</p>
      </article>
    </div>

    <article class="panel">
      <h3>7-Day Trend</h3>
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Requests</th>
              <th>Conversions</th>
              <th>Revenue</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in dailyRows" :key="row.day">
              <td>{{ row.day }}</td>
              <td>{{ row.requests.toLocaleString() }}</td>
              <td>{{ row.conversions.toLocaleString() }}</td>
              <td>${{ row.revenueUsd.toFixed(2) }}</td>
            </tr>
            <tr v-if="dailyRows.length === 0">
              <td colspan="4" class="muted">No daily metrics yet.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </section>
</template>
