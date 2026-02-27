<script setup>
import { computed, onMounted, ref, watch } from 'vue'

import { controlPlaneClient } from '../api/control-plane-client'
import { apiKeysState, clearRevealedSecret, createApiKey, hydrateApiKeys } from '../state/api-keys-state'
import { authState } from '../state/auth-state'
import { scopeState } from '../state/scope-state'

const copyState = ref('')
const keyLoading = ref(false)
const keyError = ref('')
const runtimeApiKeyInput = ref('')
const verifyLoading = ref(false)
const verifyError = ref('')
const verifyResult = ref(null)

const rows = computed(() => (Array.isArray(apiKeysState.items) ? apiKeysState.items : []))
const latestKey = computed(() => rows.value[0] || null)
const revealedSecret = computed(() => String(apiKeysState.meta.lastRevealedSecret || '').trim())
const accountId = computed(() => String(scopeState.accountId || authState.user?.accountId || '').trim())
const appId = computed(() => String(scopeState.appId || authState.user?.appId || '').trim())
const dashboardApiOrigin = computed(() => {
  if (typeof window === 'undefined') return 'https://<your-dashboard-domain>'
  return `${window.location.origin}`
})

const envSnippet = computed(() => (
  `MEDIATION_API_KEY=${runtimeApiKeyInput.value || '<generated_in_step_1>'}\nMEDIATION_APP_ID=${appId.value || '<your-app-id>'}`
))

const fastPathSnippet = computed(() => `import { createAdsSdkClient } from '@ai-network/tappy-ai-mediation/sdk/client'

const runtimeKey = process.env.MEDIATION_API_KEY
const appId = process.env.MEDIATION_APP_ID
const ads = createAdsSdkClient({
  apiBaseUrl: '${dashboardApiOrigin.value}/api',
  apiKey: runtimeKey,
  fetchImpl: fetch,
  fastPath: true,
  timeouts: { config: 1200, bid: 1200, events: 800 },
  onDiagnostics: (diagnostics, flow) => {
    console.log('[ads diagnostics]', diagnostics, flow?.decision)
  },
})

async function onUserSend(messages, chatDonePromise) {
  const clickTs = Date.now()

  const result = await ads.runChatTurnWithAd({
    appId,
    userId: 'user_001',
    chatId: 'chat_001',
    clickTs,
    bidPayload: {
      userId: 'user_001',
      chatId: 'chat_001',
      messages,
    },
    chatDonePromise,
    renderAd: (bid) => renderSponsorCard(bid),
  })

  // Runtime resolves placement from Dashboard config by default.
  // result.diagnostics.stageDurationsMs / bidProbeStatus / outcomeCategory
  return result
}`)

const verifySnippet = computed(() => `curl -sS -X POST "${dashboardApiOrigin.value}/api/v1/public/quick-start/verify" \\
  -H "Content-Type: application/json" \\
  -d '{
    "accountId": "${accountId.value || '<your-account-id>'}",
    "appId": "${appId.value || '<your-app-id>'}",
    "environment": "prod"
  }'`)

const knownFillSnippet = computed(() => `{
  "primaryKpi": "bidFillRateKnown",
  "formula": "served / bidKnownCount",
  "diagnosticOnly": ["bidUnknownCount", "unknownRate"],
  "drilldowns": [
    "timeoutRelatedCount",
    "precheckInventoryNotReadyCount",
    "budgetExceededCount",
    "resultBreakdown"
  ]
}`)

const verifyStatusTone = computed(() => {
  if (verifyResult.value?.ok === true) return 'good'
  if (!verifyResult.value) return 'neutral'
  const code = String(verifyResult.value?.code || '').toUpperCase()
  if (code === 'PRECONDITION_FAILED' || code === 'INVENTORY_EMPTY') return 'warn'
  return 'bad'
})

const verifyStatusLabel = computed(() => {
  if (verifyResult.value?.ok === true) return 'Ready'
  if (!verifyResult.value) return 'Not verified'
  return String(verifyResult.value?.code || 'Verify failed')
})

watch(revealedSecret, (value) => {
  if (!runtimeApiKeyInput.value && value) {
    runtimeApiKeyInput.value = value
  }
})

function resolveCreateKeyError(result) {
  const status = Number(result?.status || 0)
  const code = String(result?.code || '').trim().toUpperCase()
  const message = String(result?.error || 'Key generation failed')

  if (result?.requiresLogin) {
    return '[AUTH_REQUIRED] Dashboard authentication is required. Please sign in again.'
  }
  if (code === 'CSRF_MISSING' || /csrf/i.test(message)) {
    return '[CSRF_MISSING] Missing CSRF token. Refresh and try again.'
  }
  if (status >= 500) {
    return '[UPSTREAM_5XX] Control plane service is unavailable. Try again shortly.'
  }
  return message
}

function normalizeVerifyFailure(error) {
  const payload = error?.details && typeof error.details === 'object' ? error.details : {}
  const payloadError = payload?.error && typeof payload.error === 'object' ? payload.error : {}

  return {
    ok: false,
    status: Number(error?.status || 0),
    code: String(error?.code || payloadError?.code || 'VERIFY_FAILED').trim(),
    message: String(payloadError?.message || error?.message || 'Quick-start verify failed').trim(),
    remediation: String(payloadError?.remediation || '').trim(),
    details: payloadError?.details && typeof payloadError.details === 'object' ? payloadError.details : null,
  }
}

async function handleGenerateKey() {
  keyError.value = ''
  keyLoading.value = true
  try {
    const result = await createApiKey({
      accountId: accountId.value,
      appId: appId.value,
      environment: 'prod',
      name: `runtime-${Date.now()}`,
    })

    if (!result?.ok) {
      keyError.value = resolveCreateKeyError(result)
      return
    }

    await hydrateApiKeys()
    const latestSecret = String(apiKeysState.meta.lastRevealedSecret || '').trim()
    if (latestSecret) {
      runtimeApiKeyInput.value = latestSecret
    }
    clearRevealedSecret()
  } catch (error) {
    keyError.value = error instanceof Error ? error.message : 'Generate key failed'
  } finally {
    keyLoading.value = false
  }
}

async function handleVerify() {
  verifyLoading.value = true
  verifyError.value = ''
  verifyResult.value = null

  const normalizedAccountId = accountId.value
  const normalizedAppId = appId.value
  if (!normalizedAccountId || !normalizedAppId) {
    verifyLoading.value = false
    verifyError.value = 'Missing accountId/appId in current dashboard scope.'
    return
  }

  try {
    const payload = await controlPlaneClient.quickStart.verify({
      accountId: normalizedAccountId,
      appId: normalizedAppId,
      environment: 'prod',
    })

    verifyResult.value = {
      ok: true,
      status: String(payload?.status || '').trim(),
      requestId: String(payload?.requestId || '').trim(),
      evidence: payload?.evidence && typeof payload.evidence === 'object' ? payload.evidence : {},
    }
  } catch (error) {
    const normalized = normalizeVerifyFailure(error)
    verifyResult.value = normalized
    verifyError.value = normalized.message
  } finally {
    verifyLoading.value = false
  }
}

async function copy(text) {
  const value = String(text || '').trim()
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    copyState.value = 'Copied'
    setTimeout(() => {
      copyState.value = ''
    }, 1200)
  } catch {
    copyState.value = 'Copy failed'
    setTimeout(() => {
      copyState.value = ''
    }, 1200)
  }
}

onMounted(async () => {
  await hydrateApiKeys()
  if (!runtimeApiKeyInput.value && revealedSecret.value) {
    runtimeApiKeyInput.value = revealedSecret.value
  }
  clearRevealedSecret()
})
</script>

<template>
  <section class="page quickstart-page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Onboarding</p>
        <h2>Quick Start</h2>
        <p class="subtitle">FastPath default + Known Fill KPI + fail-open integration</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="verifyLoading" @click="handleVerify">
          {{ verifyLoading ? 'Verifying...' : 'Run Preflight Verify' }}
        </button>
      </div>
    </header>

    <div class="quickstart-grid">
      <article class="panel">
        <div class="panel-head">
          <h3>Step 1 · Generate Runtime Key</h3>
          <span class="status-chip">Required</span>
        </div>
        <p class="muted">Create one prod runtime key from current account/app scope.</p>

        <div class="meta-row">
          <span class="meta-label">Account</span>
          <span class="mono">{{ accountId || '-' }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">App</span>
          <span class="mono">{{ appId || '-' }}</span>
        </div>

        <button class="button button-primary" type="button" :disabled="keyLoading" @click="handleGenerateKey">
          {{ keyLoading ? 'Generating...' : 'Generate Runtime Key' }}
        </button>

        <p v-if="keyError" class="error">{{ keyError }}</p>
        <p v-else-if="latestKey" class="muted">Latest key: <span class="mono">{{ latestKey.maskedKey }}</span></p>

        <label class="field-label" for="runtimeApiKey">Runtime API Key</label>
        <input
          id="runtimeApiKey"
          v-model="runtimeApiKeyInput"
          class="input"
          autocomplete="off"
          placeholder="Paste runtime key"
        >
      </article>

      <article class="panel">
        <div class="panel-head">
          <h3>Step 2 · Preflight Verify</h3>
          <span class="status-chip" :class="`status-${verifyStatusTone}`">{{ verifyStatusLabel }}</span>
        </div>
        <p class="muted">Checks active key + inventory readiness before coding.</p>

        <div class="toolbar">
          <button class="button button-secondary" type="button" @click="copy(verifySnippet)">Copy Verify cURL</button>
          <button class="button" type="button" :disabled="verifyLoading" @click="handleVerify">Run</button>
        </div>

        <pre>{{ verifySnippet }}</pre>

        <p v-if="verifyError" class="error">{{ verifyError }}</p>
        <template v-if="verifyResult">
          <div v-if="verifyResult.ok" class="callout callout-good">
            <p><strong>requestId:</strong> <span class="mono">{{ verifyResult.requestId || '-' }}</span></p>
            <p><strong>status:</strong> <span class="mono">{{ verifyResult.status || '-' }}</span></p>
            <p>
              <strong>inventory:</strong>
              <span class="mono">
                ready={{ verifyResult.evidence?.inventory?.ready }}
                total={{ verifyResult.evidence?.inventory?.totalOffers }}
              </span>
            </p>
          </div>
          <div v-else class="callout" :class="verifyStatusTone === 'warn' ? 'callout-warn' : 'callout-bad'">
            <p><strong>code:</strong> <span class="mono">{{ verifyResult.code || '-' }}</span></p>
            <p><strong>message:</strong> {{ verifyResult.message || '-' }}</p>
            <p v-if="verifyResult.remediation"><strong>remediation:</strong> {{ verifyResult.remediation }}</p>
            <p v-if="verifyResult.details?.missingNetworks?.length">
              <strong>missing networks:</strong>
              <span class="mono">{{ verifyResult.details.missingNetworks.join(', ') }}</span>
            </p>
          </div>
        </template>
      </article>

      <article class="panel panel-full">
        <div class="panel-head">
          <h3>Step 3 · FastPath Integration Snippet</h3>
          <span class="status-chip">Recommended</span>
        </div>
        <p class="muted">Use `runChatTurnWithAd` so bid request runs in parallel with chat stream. Placement is resolved from Dashboard by default.</p>

        <div class="toolbar">
          <button class="button button-secondary" type="button" @click="copy(fastPathSnippet)">Copy FastPath Snippet</button>
          <button class="button button-secondary" type="button" @click="copy(envSnippet)">Copy .env</button>
        </div>

        <pre>{{ fastPathSnippet }}</pre>
        <pre>{{ envSnippet }}</pre>
        <p class="muted">Fail-open rule: bid timeout/error must not block chat response.</p>
      </article>

      <article class="panel panel-full">
        <div class="panel-head">
          <h3>Step 4 · Dashboard KPI Standard</h3>
          <span class="status-chip">Required</span>
        </div>
        <p class="muted">Primary KPI uses Known Fill. Unknown samples are diagnostic only.</p>

        <div class="kpi-list">
          <p><strong>Primary:</strong> <span class="mono">bidFillRateKnown = served / bidKnownCount</span></p>
          <p><strong>Diagnostics:</strong> <span class="mono">bidUnknownCount, unknownRate</span></p>
          <p><strong>Drilldowns:</strong> <span class="mono">timeoutRelatedCount, precheckInventoryNotReadyCount, budgetExceededCount</span></p>
          <p><strong>SLA target:</strong> <span class="mono">click -> bid response p95 &lt;= 1000ms</span></p>
          <p><strong>CJ optional:</strong> default required core networks are <span class="mono">partnerstack,house</span>.</p>
          <p><strong>E2E timeout:</strong> set <span class="mono">MEDIATION_TEST_HEALTH_TIMEOUT_MS=45000</span> for remote DB CI.</p>
        </div>

        <div class="toolbar">
          <button class="button button-secondary" type="button" @click="copy(knownFillSnippet)">Copy KPI JSON</button>
        </div>
        <pre>{{ knownFillSnippet }}</pre>
        <p v-if="copyState" class="muted">{{ copyState }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.quickstart-page {
  display: grid;
  gap: 16px;
}

.quickstart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.panel {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-strong);
  box-shadow: var(--panel-shadow);
}

.panel-full {
  grid-column: 1 / -1;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.status-chip {
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--line);
  font-size: 0.75rem;
  color: var(--muted);
  background: var(--surface-muted);
}

.status-good {
  border-color: var(--good-line);
  color: var(--good-text);
  background: var(--good-bg);
}

.status-warn {
  border-color: var(--warn-line);
  color: var(--warn-text);
  background: var(--warn-bg);
}

.status-bad {
  border-color: var(--bad-line);
  color: var(--bad-text);
  background: var(--bad-bg);
}

.muted {
  margin: 0;
  color: var(--muted);
}

.error {
  margin: 0;
  color: var(--bad-text);
}

.meta-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.meta-label {
  color: var(--muted);
}

.field-label {
  font-size: 0.9rem;
  color: var(--muted);
}

.input {
  width: 100%;
  min-height: 38px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  background: #fff;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.callout {
  display: grid;
  gap: 6px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--line);
}

.callout p {
  margin: 0;
}

.callout-good {
  border-color: var(--good-line);
  background: var(--good-bg);
}

.callout-warn {
  border-color: var(--warn-line);
  background: var(--warn-bg);
}

.callout-bad {
  border-color: var(--bad-line);
  background: var(--bad-bg);
}

.kpi-list {
  display: grid;
  gap: 8px;
}

.kpi-list p {
  margin: 0;
}

pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 12px;
  background: var(--surface);
  font-size: 0.8rem;
}

.mono {
  font-family: var(--font-mono);
}

@media (max-width: 980px) {
  .quickstart-grid {
    grid-template-columns: 1fr;
  }

  .panel-full {
    grid-column: auto;
  }
}
</style>
