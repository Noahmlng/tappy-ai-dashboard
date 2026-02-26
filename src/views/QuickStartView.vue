<script setup>
import { computed, onMounted, ref, watch } from 'vue'

import { controlPlaneClient } from '../api/control-plane-client'
import { apiKeysState, clearRevealedSecret, createApiKey, hydrateApiKeys } from '../state/api-keys-state'
import { authState, markOnboardingVerified } from '../state/auth-state'
import { scopeState } from '../state/scope-state'

const copyState = ref('')
const keyLoading = ref(false)
const keyError = ref('')

const bindLoading = ref(false)
const bindError = ref('')
const bindResult = ref(null)
const domainInput = ref('')
const runtimeApiKeyInput = ref('')

const placementId = 'chat_from_answer_v1'

const rows = computed(() => (Array.isArray(apiKeysState.items) ? apiKeysState.items : []))
const latestKey = computed(() => rows.value[0] || null)
const revealedSecret = computed(() => String(apiKeysState.meta.lastRevealedSecret || '').trim())
const hasAvailableKey = computed(() => rows.value.length > 0)
const onboardingVerified = computed(() => authState.onboarding.status === 'verified')

const checks = computed(() => {
  const source = bindResult.value?.checks
  if (!source || typeof source !== 'object') {
    return {
      dnsOk: false,
      cnameOk: false,
      tlsOk: false,
      connectOk: false,
      authOk: false,
      bidOk: false,
      landingUrlOk: false,
    }
  }
  return {
    dnsOk: Boolean(source.dnsOk),
    cnameOk: Boolean(source.cnameOk),
    tlsOk: Boolean(source.tlsOk),
    connectOk: Boolean(source.connectOk),
    authOk: Boolean(source.authOk),
    bidOk: Boolean(source.bidOk),
    landingUrlOk: Boolean(source.landingUrlOk),
  }
})

const bindSucceeded = computed(() => {
  const payload = bindResult.value
  const status = String(payload?.status || '').trim().toLowerCase()
  return status === 'verified' && checks.value.landingUrlOk
})

const onboardingStatusClass = computed(() => (
  onboardingVerified.value ? 'meta-pill good' : 'meta-pill warn'
))

const onboardingStatusLabel = computed(() => (
  onboardingVerified.value ? 'Verified' : 'Locked'
))

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

const bindEvidence = computed(() => (
  bindResult.value ? JSON.stringify(bindResult.value, null, 2) : ''
))

watch(revealedSecret, (value) => {
  if (!runtimeApiKeyInput.value && value) {
    runtimeApiKeyInput.value = value
  }
})

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

async function createFirstKey() {
  keyLoading.value = true
  keyError.value = ''
  clearRevealedSecret()

  try {
    const result = await createApiKey({})
    if (!result?.ok) {
      keyError.value = String(result?.error || 'Key generation failed')
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

async function verifyAndBindRuntimeDomain() {
  bindLoading.value = true
  bindError.value = ''
  bindResult.value = null

  const domain = String(domainInput.value || '').trim()
  const runtimeApiKey = String(runtimeApiKeyInput.value || '').trim()

  if (!domain) {
    bindError.value = 'Runtime domain is required.'
    bindLoading.value = false
    return
  }
  if (!runtimeApiKey) {
    bindError.value = 'Runtime API key is required to validate Authorization.'
    bindLoading.value = false
    return
  }

  try {
    const payload = await controlPlaneClient.runtimeDomain.verifyAndBind(
      {
        domain,
        placementId,
      },
      {
        apiKey: runtimeApiKey,
      },
    )
    bindResult.value = payload

    const status = String(payload?.status || '').trim().toLowerCase()
    const landingUrlOk = Boolean(payload?.checks?.landingUrlOk)
    if (status === 'verified' && landingUrlOk) {
      markOnboardingVerified(payload?.verifiedAt)
      return
    }

    bindError.value = String(payload?.failureCode || 'Runtime domain verification failed.')
  } catch (error) {
    bindError.value = error instanceof Error ? error.message : 'Runtime domain verification failed.'
  } finally {
    bindLoading.value = false
  }
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
        <p class="subtitle">Bind customer runtime domain and verify production bid path.</p>
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
        <h3>Step B: Verify and bind runtime domain</h3>
        <button class="button" type="button" :disabled="bindLoading || !hasAvailableKey" @click="verifyAndBindRuntimeDomain">
          {{ bindLoading ? 'Verifying...' : 'Verify and bind' }}
        </button>
      </div>

      <div class="form-grid">
        <label>
          Runtime domain
          <input
            v-model="domainInput"
            class="input"
            type="text"
            placeholder="runtime.customer.com"
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
      <p class="muted">The domain must resolve and CNAME to the platform runtime gateway.</p>
      <p v-if="bindError" class="muted">{{ bindError }}</p>

      <div v-if="bindResult" class="verify-evidence">
        <p><strong>requestId:</strong> <code>{{ bindResult.requestId || '-' }}</code></p>
        <p><strong>status:</strong> <code>{{ bindResult.status || '-' }}</code></p>
        <p><strong>runtimeBaseUrl:</strong> <code>{{ bindResult.runtimeBaseUrl || '-' }}</code></p>
        <p><strong>landingUrlSample:</strong> <code>{{ bindResult.landingUrlSample || '-' }}</code></p>
        <pre class="code-block">{{ bindEvidence }}</pre>
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
    </article>

    <article class="panel">
      <h3>Pass criteria</h3>
      <ul class="checklist">
        <li>Runtime key generated successfully (Step A)</li>
        <li>Runtime domain verify-and-bind returns <code>status=verified</code> (Step B)</li>
        <li>Bid verification reports <code>landingUrlOk=true</code> (Step B)</li>
        <li>Navigation unlocks only after Step B passes</li>
      </ul>
    </article>
  </section>
</template>
