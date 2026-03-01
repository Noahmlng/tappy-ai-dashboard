<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { controlPlaneClient } from '../api/control-plane-client'
import { useAutoRefresh } from '../composables/use-auto-refresh'
import {
  apiKeysState,
  clearRevealedSecret,
  createApiKey,
  hydrateApiKeys,
  revokeApiKey,
  rotateApiKey,
} from '../state/api-keys-state'
import { authState } from '../state/auth-state'
import {
  dashboardState,
  hydrateDashboardState,
  setPlacementEnabled,
  updatePlacementNumber,
  updateTriggerNumber,
} from '../state/dashboard-state'
import { scopeState } from '../state/scope-state'

const route = useRoute()
const router = useRouter()

const sectionOptions = [
  { key: 'integration', label: 'Integration' },
  { key: 'keys', label: 'API Keys' },
  { key: 'placement', label: 'Placement' },
]

const activeSection = computed(() => {
  const requested = String(route.query.section || 'integration').trim().toLowerCase()
  if (sectionOptions.some((item) => item.key === requested)) return requested
  return 'integration'
})

function switchSection(section) {
  const next = String(section || '').trim()
  if (!next || next === activeSection.value) return
  router.replace({
    path: '/settings',
    query: { section: next },
  })
}

const isBusy = computed(() => (
  Boolean(dashboardState.meta.loading)
  || Boolean(apiKeysState.meta.loading)
  || Boolean(apiKeysState.meta.syncing)
))

const accountId = computed(() => String(scopeState.accountId || authState.user?.accountId || '').trim())
const appId = computed(() => String(scopeState.appId || authState.user?.appId || '').trim())
const placements = computed(() => (Array.isArray(dashboardState.placements) ? dashboardState.placements : []))
const keyRows = computed(() => (Array.isArray(apiKeysState.items) ? apiKeysState.items : []))

const verifyLoading = ref(false)
const verifyError = ref('')
const verifyResult = ref(null)
const keyError = ref('')

const verifyCurlSnippet = computed(() => {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://<dashboard-domain>'
  return `curl -sS -X POST "${origin}/api/v1/public/quick-start/verify" \\\n  -H "Content-Type: application/json" \\\n  -d '{"accountId":"${accountId.value || '<account-id>'}","appId":"${appId.value || '<app-id>'}","environment":"prod"}'`
})

const sdkSnippet = computed(() => {
  return `createAdsSdkClient({\n  apiBaseUrl: '${typeof window !== 'undefined' ? window.location.origin : 'https://<dashboard-domain>'}/api',\n  apiKey: process.env.MEDIATION_API_KEY\n})`
})

async function refreshAll() {
  await Promise.all([
    hydrateDashboardState(),
    hydrateApiKeys(),
  ])
}

const { triggerRefresh } = useAutoRefresh(
  () => refreshAll(),
  {
    intervalMs: 30_000,
    isBusy: () => isBusy.value,
  },
)

async function runRefresh() {
  await triggerRefresh()
}

function placementTriggerValue(placement, key, fallback) {
  const trigger = placement?.trigger
  const numeric = Number(trigger && trigger[key])
  return Number.isFinite(numeric) ? numeric : fallback
}

async function handleVerify() {
  verifyLoading.value = true
  verifyError.value = ''
  verifyResult.value = null

  if (!accountId.value || !appId.value) {
    verifyLoading.value = false
    verifyError.value = 'Missing account/app scope.'
    return
  }

  try {
    const payload = await controlPlaneClient.quickStart.verify({
      accountId: accountId.value,
      appId: appId.value,
      environment: 'prod',
    })
    verifyResult.value = {
      ok: true,
      status: String(payload?.status || '').trim(),
      requestId: String(payload?.requestId || '').trim(),
      inventoryReady: Boolean(payload?.evidence?.inventory?.ready),
    }
  } catch (error) {
    verifyError.value = error instanceof Error ? error.message : 'Verify failed'
    verifyResult.value = {
      ok: false,
      status: 'failed',
      requestId: '',
      inventoryReady: false,
    }
  } finally {
    verifyLoading.value = false
  }
}

async function handleCreateKey() {
  keyError.value = ''
  clearRevealedSecret()
  const result = await createApiKey({})
  if (!result?.ok) {
    keyError.value = String(result?.error || 'Create key failed')
    return
  }
  await hydrateApiKeys()
}

async function handleRotateKey(keyId) {
  await rotateApiKey(keyId)
}

async function handleRevokeKey(keyId) {
  await revokeApiKey(keyId)
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function keyStatusClass(status) {
  return status === 'revoked' ? 'status-pill bad' : 'status-pill good'
}
</script>

<template>
  <section class="page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Settings</p>
        <h2>Settings</h2>
        <p class="subtitle">Integration, key lifecycle, and placement controls</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="isBusy" @click="runRefresh">
          {{ isBusy ? 'Syncing...' : 'Sync' }}
        </button>
      </div>
    </header>

    <article class="panel panel-soft">
      <div class="toolbar-actions">
        <button
          v-for="option in sectionOptions"
          :key="option.key"
          class="button button-secondary"
          type="button"
          :disabled="activeSection === option.key"
          @click="switchSection(option.key)"
        >
          {{ option.label }}
        </button>
      </div>
    </article>

    <article v-if="activeSection === 'integration'" class="panel">
      <div class="panel-toolbar">
        <h3>Integration Readiness</h3>
        <button class="button" type="button" :disabled="verifyLoading" @click="handleVerify">
          {{ verifyLoading ? 'Checking...' : 'Run Verify' }}
        </button>
      </div>
      <p class="muted">Account: <strong>{{ accountId || '-' }}</strong></p>
      <p class="muted">App: <strong>{{ appId || '-' }}</strong></p>
      <p class="muted">Runtime: <strong>{{ dashboardState.meta.connected ? 'Connected' : 'Unavailable' }}</strong></p>
      <p v-if="verifyError" class="muted">{{ verifyError }}</p>
      <p v-if="verifyResult" class="muted">
        Verify status={{ verifyResult.status || '-' }} · requestId={{ verifyResult.requestId || '-' }}
      </p>

      <details>
        <summary>显示技术细节</summary>
        <div class="stack-sm">
          <p class="muted">Verify cURL</p>
          <pre>{{ verifyCurlSnippet }}</pre>
          <p class="muted">SDK snippet</p>
          <pre>{{ sdkSnippet }}</pre>
        </div>
      </details>
    </article>

    <article v-if="activeSection === 'keys'" class="panel">
      <div class="panel-toolbar">
        <h3>API Keys</h3>
        <button class="button" type="button" :disabled="isBusy || !scopeState.accountId" @click="handleCreateKey">
          {{ isBusy ? 'Working...' : 'Generate Key' }}
        </button>
      </div>
      <p v-if="keyError" class="muted">{{ keyError }}</p>
      <p v-if="apiKeysState.meta.lastRevealedSecret" class="muted">
        Secret (once): <code>{{ apiKeysState.meta.lastRevealedSecret }}</code>
      </p>

      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Masked</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in keyRows" :key="row.keyId">
              <td>{{ row.name }}</td>
              <td>
                <span :class="keyStatusClass(row.status)">{{ row.status }}</span>
              </td>
              <td><code>{{ row.maskedKey }}</code></td>
              <td>{{ formatDate(row.createdAt) }}</td>
              <td>
                <div class="toolbar-actions">
                  <button
                    class="button button-secondary"
                    type="button"
                    :disabled="isBusy || row.status === 'revoked'"
                    @click="handleRotateKey(row.keyId)"
                  >
                    Rotate
                  </button>
                  <button
                    class="button button-danger"
                    type="button"
                    :disabled="isBusy || row.status === 'revoked'"
                    @click="handleRevokeKey(row.keyId)"
                  >
                    Revoke
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="keyRows.length === 0">
              <td colspan="5" class="muted">No keys.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>

    <article v-if="activeSection === 'placement'" class="panel">
      <div class="panel-toolbar">
        <h3>Placement</h3>
        <p class="muted">{{ placements.length }}</p>
      </div>

      <div class="placement-card-grid">
        <article v-for="placement in placements" :key="placement.placementId" class="panel panel-soft">
          <div class="panel-head">
            <div>
              <h3>{{ placement.placementId }}</h3>
              <p class="muted">{{ placement.surface || placement.placementType || 'chat' }}</p>
            </div>
            <label class="inline-switch">
              <input
                type="checkbox"
                :checked="placement.enabled"
                @change="setPlacementEnabled(placement.placementId, $event.target.checked)"
              >
              <span>{{ placement.enabled ? 'On' : 'Off' }}</span>
            </label>
          </div>

          <div class="form-grid">
            <label>
              Timeout (ms)
              <input
                class="input"
                type="number"
                min="100"
                step="50"
                :value="Number(placement.globalTimeoutMs || 1200)"
                @change="updatePlacementNumber(placement.placementId, 'globalTimeoutMs', $event.target.value, 100)"
              >
            </label>
            <label>
              Fanout
              <input
                class="input"
                type="number"
                min="1"
                max="10"
                :value="Number(placement.maxFanout || 3)"
                @change="updatePlacementNumber(placement.placementId, 'maxFanout', $event.target.value, 1)"
              >
            </label>
            <label>
              Intent Threshold
              <input
                class="input"
                type="number"
                min="0"
                max="1"
                step="0.01"
                :value="placementTriggerValue(placement, 'intentThreshold', 0.7)"
                @change="updateTriggerNumber(placement.placementId, 'intentThreshold', $event.target.value)"
              >
            </label>
          </div>
        </article>

        <article v-if="placements.length === 0" class="panel panel-soft">
          <p class="muted">No placement.</p>
        </article>
      </div>
    </article>
  </section>
</template>

<style scoped>
.stack-sm {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}

summary {
  cursor: pointer;
  color: var(--text);
  font-weight: 600;
}
</style>
