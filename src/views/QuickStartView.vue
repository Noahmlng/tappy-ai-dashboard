<script setup>
import { computed, onMounted, ref, watch } from 'vue'

import { apiKeysState, clearRevealedSecret, createApiKey, hydrateApiKeys } from '../state/api-keys-state'
import { authState, markOnboardingVerified } from '../state/auth-state'
import { scopeState } from '../state/scope-state'

const placementId = 'chat_from_answer_v1'

const copyState = ref('')
const keyLoading = ref(false)
const keyError = ref('')
const bidLoading = ref(false)
const bidError = ref('')
const bidResult = ref(null)
const runtimeApiKeyInput = ref('')

const rows = computed(() => (Array.isArray(apiKeysState.items) ? apiKeysState.items : []))
const latestKey = computed(() => rows.value[0] || null)
const revealedSecret = computed(() => String(apiKeysState.meta.lastRevealedSecret || '').trim())
const accountId = computed(() => String(scopeState.accountId || authState.user?.accountId || '').trim())
const appId = computed(() => String(scopeState.appId || authState.user?.appId || '').trim())
const onboardingStatus = computed(() => String(authState.onboarding.status || 'locked').toLowerCase())

const envSnippet = computed(() => (
  `MEDIATION_API_KEY=${runtimeApiKeyInput.value || revealedSecret.value || '<generated_in_step_a>'}
MEDIATION_RUNTIME_API_BASE_URL=https://runtime.example.com/api`
))

const integrationSnippet = computed(() => `const apiKey = process.env.MEDIATION_API_KEY;
const runtimeApiBaseUrl = process.env.MEDIATION_RUNTIME_API_BASE_URL;

const bidRes = await fetch(\`${'${runtimeApiBaseUrl}'}/v2/bid\`, {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer ${'${apiKey}'}\`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    userId: 'session_001',
    chatId: 'session_001',
    placementId: '${placementId}',
    messages: [
      { role: 'user', content: 'Recommend waterproof running shoes' },
      { role: 'assistant', content: 'Prioritize grip and breathable waterproof upper.' }
    ]
  })
});

if (!bidRes.ok) throw new Error(\`v2/bid failed: ${'${bidRes.status}'}\`);
const bidJson = await bidRes.json();
console.log({ requestId: bidJson.requestId, filled: bidJson.filled, landingUrl: bidJson.landingUrl });`)

const bidEvidence = computed(() => (
  bidResult.value ? JSON.stringify(bidResult.value, null, 2) : ''
))
const bidProxyTargetMissing = computed(() => (
  String(bidResult.value?.error?.code || '').trim() === 'PROXY_RUNTIME_TARGET_NOT_CONFIGURED'
))

watch(revealedSecret, (value) => {
  if (!runtimeApiKeyInput.value && value) {
    runtimeApiKeyInput.value = value
  }
})

function resolveRuntimeApiKey() {
  return String(runtimeApiKeyInput.value || revealedSecret.value || '').trim()
}

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

async function handleRunBidCheck() {
  bidError.value = ''
  bidResult.value = null

  const runtimeApiKey = resolveRuntimeApiKey()
  if (!runtimeApiKey) {
    bidError.value = 'Runtime API key is required before testing /api/v2/bid.'
    return
  }

  bidLoading.value = true
  try {
    const response = await fetch('/api/v2/bid', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtimeApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'onboarding_user_001',
        chatId: 'onboarding_chat_001',
        placementId,
        messages: [
          { role: 'user', content: 'Recommend running shoes for rainy days' },
          { role: 'assistant', content: 'Focus on grip and waterproof upper.' },
        ],
      }),
    })

    const payload = await response.json().catch(() => ({}))
    bidResult.value = {
      httpStatus: response.status,
      ok: response.ok,
      ...payload,
    }

    if (!response.ok) {
      const errorCode = String(payload?.error?.code || '').trim()
      const errorMessage = String(payload?.error?.message || '').trim()
      if (errorCode === 'PROXY_RUNTIME_TARGET_NOT_CONFIGURED') {
        bidError.value = '[PROXY_RUNTIME_TARGET_NOT_CONFIGURED] Optional dashboard check is unavailable. Set MEDIATION_RUNTIME_API_BASE_URL in this dashboard deployment.'
        return
      }
      bidError.value = errorCode ? `[${errorCode}] ${errorMessage}` : (errorMessage || `HTTP ${response.status}`)
      return
    }

    if (String(payload?.requestId || '').trim()) {
      markOnboardingVerified()
    }
  } catch (error) {
    bidError.value = error instanceof Error ? error.message : 'Request /api/v2/bid failed'
  } finally {
    bidLoading.value = false
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
  <section class="quickstart-grid">
    <article class="panel">
      <h2>Step A · Generate Runtime Key</h2>
      <p class="muted">Use a runtime key only. This is enough to start direct integration.</p>

      <div class="meta-row">
        <span class="meta-label">Account</span>
        <span class="mono">{{ accountId || '-' }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">App</span>
        <span class="mono">{{ appId || '-' }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Onboarding</span>
        <span class="mono">{{ onboardingStatus }}</span>
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
      <h2>Optional Diagnostic · Run /api/v2/bid</h2>
      <p class="muted">Not required for integration. This only checks whether this dashboard deployment can proxy runtime requests.</p>

      <button class="button button-primary" type="button" :disabled="bidLoading" @click="handleRunBidCheck">
        {{ bidLoading ? 'Running...' : 'Run Bid Check' }}
      </button>

      <p v-if="bidError" class="error">{{ bidError }}</p>
      <p v-if="bidProxyTargetMissing" class="muted">
        Set <span class="mono">MEDIATION_RUNTIME_API_BASE_URL</span> in Vercel Project Settings for this dashboard.
      </p>

      <div v-if="bidEvidence" class="evidence">
        <div class="toolbar">
          <h3>Bid Result</h3>
          <button class="button button-secondary" type="button" @click="copy(bidEvidence)">Copy JSON</button>
        </div>
        <pre>{{ bidEvidence }}</pre>
      </div>
    </article>

    <article class="panel panel-full">
      <div class="toolbar">
        <h2>Direct Integration Snippet</h2>
        <button class="button button-secondary" type="button" @click="copy(integrationSnippet)">Copy</button>
      </div>

      <p class="muted">Main path is only: runtime key + <span class="mono">POST /api/v2/bid</span>. No bootstrap/bind/events flow.</p>
      <pre>{{ integrationSnippet }}</pre>

      <div class="toolbar env-toolbar">
        <h3>.env</h3>
        <button class="button button-secondary" type="button" @click="copy(envSnippet)">Copy</button>
      </div>
      <pre>{{ envSnippet }}</pre>
      <p v-if="copyState" class="muted">{{ copyState }}</p>
    </article>
  </section>
</template>

<style scoped>
.quickstart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.panel {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--border-color, #d8dde6);
  border-radius: 12px;
  background: var(--panel-bg, #fff);
}

.panel-full {
  grid-column: 1 / -1;
}

.muted {
  margin: 0;
  color: var(--text-muted, #5d6678);
}

.error {
  margin: 0;
  color: #b91c1c;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.meta-label {
  color: var(--text-muted, #5d6678);
}

.field-label {
  font-size: 0.9rem;
  color: var(--text-muted, #5d6678);
}

.input {
  width: 100%;
  min-height: 38px;
  border: 1px solid var(--border-color, #d8dde6);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--border-color, #d8dde6);
  border-radius: 10px;
  padding: 12px;
  background: #f8fafc;
  font-size: 0.82rem;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
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
