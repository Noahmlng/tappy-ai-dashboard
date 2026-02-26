<script setup>
import { computed, onMounted, ref, watch } from 'vue'

import { controlPlaneClient } from '../api/control-plane-client'
import { apiKeysState, clearRevealedSecret, createApiKey, hydrateApiKeys } from '../state/api-keys-state'
import {
  authState,
  hydrateAuthSession,
  markOnboardingPending,
  markOnboardingVerified,
} from '../state/auth-state'
import { scopeState } from '../state/scope-state'

const copyState = ref('')
const keyLoading = ref(false)
const keyError = ref('')

const bindLoading = ref(false)
const liveProbeLoading = ref(false)
const browserProbeLoading = ref(false)
const runtimeError = ref('')

const runtimeResult = ref(null)
const bootstrapResult = ref(null)
const domainInput = ref('')
const runtimeApiKeyInput = ref('')
const probeHeaderKey1 = ref('')
const probeHeaderValue1 = ref('')
const probeHeaderKey2 = ref('')
const probeHeaderValue2 = ref('')

const placementId = 'chat_from_answer_v1'

const rows = computed(() => (Array.isArray(apiKeysState.items) ? apiKeysState.items : []))
const latestKey = computed(() => rows.value[0] || null)
const revealedSecret = computed(() => String(apiKeysState.meta.lastRevealedSecret || '').trim())
const hasAvailableKey = computed(() => rows.value.length > 0)

const onboardingStatus = computed(() => String(authState.onboarding.status || 'locked').toLowerCase())
const onboardingStatusClass = computed(() => {
  if (onboardingStatus.value === 'verified') return 'meta-pill good'
  if (onboardingStatus.value === 'pending') return 'meta-pill warn'
  return 'meta-pill warn'
})
const onboardingStatusLabel = computed(() => {
  if (onboardingStatus.value === 'verified') return 'Verified'
  if (onboardingStatus.value === 'pending') return 'Pending'
  return 'Locked'
})

const runtimeStatus = computed(() => String(runtimeResult.value?.status || '').trim().toLowerCase())
const runtimeBindStage = computed(() => String(runtimeResult.value?.bindStage || '').trim().toLowerCase())
const runtimeProbeCode = computed(() => (
  String(
    runtimeResult.value?.probeResult?.code
    || runtimeResult.value?.failureCode
    || runtimeResult.value?.serverProbe?.code
    || '',
  ).trim().toUpperCase()
))
const runtimeProbeDetail = computed(() => (
  String(
    runtimeResult.value?.probeResult?.detail
    || runtimeResult.value?.serverProbe?.detail
    || '',
  ).trim()
))
const runtimeBindStateLabel = computed(() => {
  if (runtimeStatus.value === 'verified') return 'Verified'
  if (runtimeStatus.value === 'pending') return 'Bound (Pending)'
  if (runtimeStatus.value === 'failed') return 'Rejected'
  return '-'
})
const showBrowserProbeButton = computed(() => {
  if (!hasAvailableKey.value) return false
  if (!runtimeResult.value) return false
  if (runtimeStatus.value === 'verified') return false
  if (runtimeResult.value?.serverProbe) {
    return runtimeResult.value.serverProbe.ok === false
  }
  return runtimeStatus.value === 'pending' || runtimeBindStage.value === 'probe_failed'
})

const envSnippet = computed(() => `MEDIATION_API_KEY=${runtimeApiKeyInput.value || revealedSecret.value || '<generated_in_step_a>'}`)

const sdkSnippet = computed(() => `const apiKey = process.env.MEDIATION_API_KEY;

const bootstrapRes = await fetch('/api/v1/public/sdk/bootstrap', {
  method: 'GET',
  headers: {
    'Authorization': \`Bearer ${'${apiKey}'}\`
  }
});
if (!bootstrapRes.ok) throw new Error(\`bootstrap failed: ${'${bootstrapRes.status}'}\`);

const bootstrap = await bootstrapRes.json();
const baseUrl = bootstrap.runtimeBaseUrl;
const placementId = bootstrap.placementDefaults?.placementId || '${placementId}';

const bidRes = await fetch(\`${'${baseUrl}'}/api/v2/bid\`, {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer ${'${apiKey}'}\`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    userId: 'session_001',
    chatId: 'session_001',
    placementId,
    messages: [
      { role: 'user', content: 'Recommend waterproof running shoes' },
      { role: 'assistant', content: 'Prioritize grip and breathable waterproof upper.' }
    ]
  })
});

if (!bidRes.ok) throw new Error(\`v2/bid failed: ${'${bidRes.status}'}\`);
const bidJson = await bidRes.json();
if (!bidJson.landingUrl) throw new Error('landingUrl missing in bid response');
console.log({ requestId: bidJson.requestId, landingUrl: bidJson.landingUrl });`)

const runtimeEvidence = computed(() => (
  runtimeResult.value ? JSON.stringify(runtimeResult.value, null, 2) : ''
))

const bootstrapEvidence = computed(() => (
  bootstrapResult.value ? JSON.stringify(bootstrapResult.value, null, 2) : ''
))

watch(revealedSecret, (value) => {
  if (!runtimeApiKeyInput.value && value) {
    runtimeApiKeyInput.value = value
  }
})

function normalizeRuntimeBaseUrl(value) {
  const input = String(value || '').trim()
  if (!input) return ''
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)
    ? input.replace(/\/$/, '')
    : `https://${input}`
}

function buildProbeHeaders() {
  const entries = []
  const key1 = String(probeHeaderKey1.value || '').trim().toLowerCase()
  const value1 = String(probeHeaderValue1.value || '').trim()
  const key2 = String(probeHeaderKey2.value || '').trim().toLowerCase()
  const value2 = String(probeHeaderValue2.value || '').trim()

  if (key1 && value1) entries.push([key1, value1])
  if (key2 && value2) entries.push([key2, value2])
  return Object.fromEntries(entries)
}

function hasCookie(name) {
  const normalizedName = String(name || '').trim()
  if (!normalizedName || typeof document === 'undefined') return false
  const source = String(document.cookie || '')
  return source
    .split(';')
    .map((item) => item.trim())
    .some((item) => item.startsWith(`${normalizedName}=`))
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

function logCreateKeyDiagnostics(result, phase) {
  if (!import.meta.env.DEV) return
  console.info('[generate-key:diagnostic]', {
    phase,
    status: Number(result?.status || 0),
    code: String(result?.code || ''),
    requiresLogin: Boolean(result?.requiresLogin),
    hasDashCsrfCookie: hasCookie('dash_csrf'),
    hasLocalStorageDashboardToken: typeof window !== 'undefined'
      ? Boolean(window.localStorage.getItem('dashboard_access_token'))
      : false,
    authMode: 'cookie',
  })
}

function applyRuntimeOnboardingStatus(status, verifiedAt) {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'verified') {
    markOnboardingVerified(verifiedAt)
    return
  }
  if (normalized === 'pending') {
    markOnboardingPending()
  }
}

function toRuntimeFailureText(payload = {}, fallback = 'Runtime probe failed.') {
  const code = String(payload?.failureCode || payload?.probeResult?.code || payload?.serverProbe?.code || '').trim().toUpperCase()
  const detail = String(
    payload?.probeResult?.detail
    || payload?.serverProbe?.detail
    || payload?.browserProbe?.detail
    || fallback,
  ).trim()
  return code ? `[${code}] ${detail}` : detail
}

async function refreshBootstrap() {
  const runtimeApiKey = String(runtimeApiKeyInput.value || '').trim()
  if (!runtimeApiKey) return
  try {
    const bootstrap = await controlPlaneClient.sdk.bootstrap({
      apiKey: runtimeApiKey,
    })
    bootstrapResult.value = bootstrap
  } catch {
    bootstrapResult.value = null
  }
}

async function applyRuntimePayload(payload = {}) {
  runtimeResult.value = payload
  const status = String(payload?.status || '').trim().toLowerCase()
  applyRuntimeOnboardingStatus(status, payload?.verifiedAt)

  if (status === 'verified' || status === 'pending') {
    await refreshBootstrap()
  }

  if (status === 'verified') {
    runtimeError.value = ''
    return
  }

  runtimeError.value = toRuntimeFailureText(payload, 'Runtime domain is not ready yet.')
}

function buildBrowserProbePayload(result = {}) {
  return {
    ok: Boolean(result.ok),
    code: String(result.code || '').trim().toUpperCase() || 'EGRESS_BLOCKED',
    httpStatus: Number(result.httpStatus || 0) || 0,
    detail: String(result.detail || '').trim(),
    landingUrl: String(result.landingUrl || '').trim(),
  }
}

async function runBrowserProbeDirect(runtimeBaseUrl, runtimeApiKey, probeHeaders = {}) {
  const headers = {
    ...probeHeaders,
    Authorization: `Bearer ${runtimeApiKey}`,
    'Content-Type': 'application/json',
  }

  try {
    const response = await fetch(`${runtimeBaseUrl}/api/v2/bid`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: 'browser_probe_user',
        chatId: 'browser_probe_chat',
        placementId,
        messages: [
          { role: 'user', content: 'browser probe' },
        ],
      }),
    })

    const status = Number(response.status || 0)
    if (!response.ok) {
      let code = 'EGRESS_BLOCKED'
      if (status === 404) code = 'ENDPOINT_404'
      else if (status === 405) code = 'METHOD_405'
      else if (status === 401 || status === 403) code = 'AUTH_401_403'
      else if (status >= 500) code = 'UPSTREAM_5XX'
      return {
        ok: false,
        code,
        httpStatus: status,
        detail: `Browser probe failed with status ${status}.`,
      }
    }

    const payload = await response.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return {
        ok: false,
        code: 'BID_INVALID_RESPONSE_JSON',
        httpStatus: status,
        detail: 'Browser probe response is not valid JSON.',
      }
    }

    const landingUrl = String(
      payload?.landingUrl
      || payload?.url
      || payload?.link
      || payload?.ad?.landingUrl
      || payload?.ad?.url
      || payload?.ad?.link
      || '',
    ).trim()

    if (!landingUrl) {
      return {
        ok: false,
        code: 'LANDING_URL_MISSING',
        httpStatus: status,
        detail: 'Browser probe response has no landing URL.',
      }
    }

    return {
      ok: true,
      code: 'VERIFIED',
      httpStatus: status,
      detail: 'Browser probe succeeded.',
      landingUrl,
    }
  } catch (error) {
    return {
      ok: false,
      code: 'EGRESS_BLOCKED',
      httpStatus: 0,
      detail: error instanceof Error ? error.message : 'Browser probe network blocked.',
    }
  }
}

async function syncProbeWithServer({ runBrowserProbe = false, browserProbe = null } = {}) {
  const domain = normalizeRuntimeBaseUrl(domainInput.value)
  const runtimeApiKey = String(runtimeApiKeyInput.value || '').trim()
  const probeHeaders = buildProbeHeaders()

  const payload = await controlPlaneClient.runtimeDomain.probe(
    {
      domain: domain || undefined,
      placementId,
      probeHeaders,
      runBrowserProbe,
      browserProbe,
    },
    {
      apiKey: runtimeApiKey,
    },
  )

  await applyRuntimePayload(payload)
  return payload
}

async function createFirstKey() {
  keyLoading.value = true
  keyError.value = ''
  clearRevealedSecret()

  try {
    let result = await createApiKey({})
    if (!result?.ok && result?.requiresLogin) {
      logCreateKeyDiagnostics(result, 'first_auth_failure')
      await hydrateAuthSession()
      if (authState.authenticated) {
        result = await createApiKey({})
      }
    }

    if (!result?.ok) {
      keyError.value = resolveCreateKeyError(result)
      logCreateKeyDiagnostics(result, 'final_failure')
      return
    }

    if (revealedSecret.value) {
      runtimeApiKeyInput.value = revealedSecret.value
    }
    await hydrateApiKeys()
  } catch (error) {
    keyError.value = error instanceof Error ? error.message : 'Key generation failed'
  } finally {
    keyLoading.value = false
  }
}

async function bindRuntimeDomain() {
  bindLoading.value = true
  runtimeError.value = ''
  runtimeResult.value = null
  bootstrapResult.value = null

  const runtimeBaseUrl = normalizeRuntimeBaseUrl(domainInput.value)
  const runtimeApiKey = String(runtimeApiKeyInput.value || '').trim()
  const probeHeaders = buildProbeHeaders()

  if (!runtimeBaseUrl) {
    runtimeError.value = 'Runtime domain is required.'
    bindLoading.value = false
    return
  }
  if (!runtimeApiKey) {
    runtimeError.value = 'Runtime API key is required to validate Authorization.'
    bindLoading.value = false
    return
  }

  try {
    const payload = await controlPlaneClient.runtimeDomain.verifyAndBind(
      {
        domain: runtimeBaseUrl,
        placementId,
        probeHeaders,
      },
      {
        apiKey: runtimeApiKey,
      },
    )

    await applyRuntimePayload(payload)

    if (String(payload?.status || '').toLowerCase() === 'pending') {
      await runBrowserProbe({ silent: true })
    }
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : 'Runtime domain bind failed.'
  } finally {
    bindLoading.value = false
  }
}

async function runLiveProbe() {
  liveProbeLoading.value = true
  runtimeError.value = ''

  const runtimeBaseUrl = normalizeRuntimeBaseUrl(domainInput.value)
  const runtimeApiKey = String(runtimeApiKeyInput.value || '').trim()
  if (!runtimeBaseUrl || !runtimeApiKey) {
    runtimeError.value = 'Runtime domain and API key are required before live probe.'
    liveProbeLoading.value = false
    return
  }

  try {
    const payload = await syncProbeWithServer({
      runBrowserProbe: false,
    })
    if (String(payload?.status || '').toLowerCase() === 'pending') {
      await runBrowserProbe({ silent: true })
    }
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : 'Live probe failed.'
  } finally {
    liveProbeLoading.value = false
  }
}

async function runBrowserProbe({ silent = false } = {}) {
  browserProbeLoading.value = true
  if (!silent) runtimeError.value = ''

  const runtimeBaseUrl = normalizeRuntimeBaseUrl(domainInput.value)
  const runtimeApiKey = String(runtimeApiKeyInput.value || '').trim()
  if (!runtimeBaseUrl || !runtimeApiKey) {
    runtimeError.value = 'Runtime domain and API key are required before browser probe.'
    browserProbeLoading.value = false
    return
  }

  try {
    const browserProbeRaw = await runBrowserProbeDirect(runtimeBaseUrl, runtimeApiKey, buildProbeHeaders())
    const browserProbe = buildBrowserProbePayload(browserProbeRaw)
    await syncProbeWithServer({
      runBrowserProbe: true,
      browserProbe,
    })
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : 'Browser probe failed.'
  } finally {
    browserProbeLoading.value = false
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value)
    copyState.value = 'Copied'
  } catch {
    copyState.value = 'Copy failed'
  }
  setTimeout(() => {
    copyState.value = ''
  }, 1200)
}

onMounted(() => {
  hydrateApiKeys()
})
</script>

<template>
  <section class="page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Onboarding</p>
        <h2>Onboarding</h2>
        <p class="subtitle">Bind customer runtime domain first, then verify runtime probe health.</p>
      </div>
      <div class="header-actions">
        <span :class="onboardingStatusClass">{{ onboardingStatusLabel }}</span>
      </div>
    </header>

    <article class="panel">
      <div class="panel-toolbar">
        <h3>Step A: Generate runtime key</h3>
        <button class="button" type="button" :disabled="keyLoading || !scopeState.accountId" @click="createFirstKey">
          {{ keyLoading ? 'Generating...' : 'Generate key' }}
        </button>
      </div>
      <p class="muted">Account <strong>{{ scopeState.accountId || '-' }}</strong></p>
      <p v-if="keyError" class="muted">{{ keyError }}</p>
      <div v-if="revealedSecret" class="secret-banner">
        <strong>Secret (once)</strong>
        <code>{{ revealedSecret }}</code>
      </div>
      <p v-if="latestKey" class="muted">
        Latest key <code>{{ latestKey.maskedKey || latestKey.keyId }}</code>
      </p>
    </article>

    <article class="panel">
      <div class="panel-toolbar">
        <h3>Step B: Bind and probe runtime domain</h3>
      </div>

      <div class="form-grid">
        <label>
          Runtime domain
          <input
            v-model="domainInput"
            class="input"
            type="text"
            placeholder="https://runtime.customer.com"
            autocomplete="off"
          >
        </label>
        <label>
          Runtime API key
          <input
            v-model="runtimeApiKeyInput"
            class="input"
            type="password"
            placeholder="sk_live_xxx"
            autocomplete="off"
          >
        </label>
      </div>

      <div class="form-grid">
        <label>
          Probe Header Key (optional)
          <input v-model="probeHeaderKey1" class="input" type="text" placeholder="x-vercel-protection-bypass">
        </label>
        <label>
          Probe Header Value (optional)
          <input v-model="probeHeaderValue1" class="input" type="password" placeholder="token_1">
        </label>
      </div>
      <div class="form-grid">
        <label>
          Probe Header Key 2 (optional)
          <input v-model="probeHeaderKey2" class="input" type="text" placeholder="cf-access-client-id">
        </label>
        <label>
          Probe Header Value 2 (optional)
          <input v-model="probeHeaderValue2" class="input" type="password" placeholder="token_2">
        </label>
      </div>

      <div class="toolbar-actions">
        <button class="button" type="button" :disabled="bindLoading || !hasAvailableKey" @click="bindRuntimeDomain">
          {{ bindLoading ? 'Binding...' : 'Bind domain' }}
        </button>
        <button class="button button-secondary" type="button" :disabled="liveProbeLoading || !hasAvailableKey" @click="runLiveProbe">
          {{ liveProbeLoading ? 'Probing...' : 'Run live probe' }}
        </button>
        <button
          v-if="showBrowserProbeButton"
          class="button button-secondary"
          type="button"
          :disabled="browserProbeLoading || !hasAvailableKey"
          @click="runBrowserProbe()"
        >
          {{ browserProbeLoading ? 'Browser probing...' : 'Run browser probe' }}
        </button>
      </div>

      <p class="muted">
        Bind success may still return <code>pending</code> if server-side probe fails. Pending unlocks dashboard with warning.
      </p>
      <p v-if="runtimeError" class="muted">{{ runtimeError }}</p>

      <div v-if="runtimeResult" class="verify-evidence">
        <p><strong>requestId:</strong> <code>{{ runtimeResult.requestId || '-' }}</code></p>
        <p><strong>bindState:</strong> <code>{{ runtimeBindStateLabel }}</code></p>
        <p><strong>status:</strong> <code>{{ runtimeResult.status || '-' }}</code></p>
        <p><strong>bindStage:</strong> <code>{{ runtimeResult.bindStage || '-' }}</code></p>
        <p><strong>runtimeBaseUrl:</strong> <code>{{ runtimeResult.runtimeBaseUrl || '-' }}</code></p>
        <p><strong>probeCode:</strong> <code>{{ runtimeProbeCode || '-' }}</code></p>
        <p><strong>probeDetail:</strong> <code>{{ runtimeProbeDetail || '-' }}</code></p>
        <p><strong>landingUrlSample:</strong> <code>{{ runtimeResult.landingUrlSample || '-' }}</code></p>
        <ul v-if="Array.isArray(runtimeResult.nextActions) && runtimeResult.nextActions.length > 0" class="checklist">
          <li v-for="action in runtimeResult.nextActions" :key="action">{{ action }}</li>
        </ul>
        <pre class="code-block">{{ runtimeEvidence }}</pre>
      </div>
    </article>

    <article class="panel">
      <div class="panel-toolbar">
        <h3>Step C: Copy SDK integration</h3>
        <button class="button" type="button" @click="copyText(envSnippet)">
          Copy env
        </button>
      </div>
      <pre class="code-block">{{ envSnippet }}</pre>
      <p class="muted">Only one env var is required: <code>MEDIATION_API_KEY</code>.</p>

      <div class="panel-toolbar">
        <h3>Bootstrap + bid call</h3>
        <button class="button button-secondary" type="button" @click="copyText(sdkSnippet)">Copy snippet</button>
      </div>
      <pre class="code-block">{{ sdkSnippet }}</pre>
      <p v-if="copyState" class="copy-note">{{ copyState }}</p>
      <div v-if="bootstrapResult" class="verify-evidence">
        <p><strong>bootstrap.runtimeBaseUrl:</strong> <code>{{ bootstrapResult.runtimeBaseUrl || '-' }}</code></p>
        <p><strong>bootstrap.bindStatus:</strong> <code>{{ bootstrapResult.bindStatus || '-' }}</code></p>
        <p><strong>bootstrap.tenantId:</strong> <code>{{ bootstrapResult.tenantId || '-' }}</code></p>
        <pre class="code-block">{{ bootstrapEvidence }}</pre>
      </div>
    </article>

    <article class="panel">
      <h3>Pass criteria</h3>
      <ul class="checklist">
        <li>Runtime key generated successfully (Step A)</li>
        <li>Domain bind returns <code>verified</code> or <code>pending</code> (Step B)</li>
        <li>Probe diagnostics show actionable code and next actions (Step B)</li>
        <li>Only <code>verified</code> marks onboarding complete; <code>pending</code> keeps warning banner</li>
      </ul>
    </article>
  </section>
</template>
