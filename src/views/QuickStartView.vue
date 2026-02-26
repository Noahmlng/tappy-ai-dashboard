<script setup>
import { computed, onMounted, ref } from 'vue'

import { controlPlaneClient } from '../api/control-plane-client'
import { apiKeysState, clearRevealedSecret, createApiKey, hydrateApiKeys } from '../state/api-keys-state'
import { authState, markOnboardingVerified } from '../state/auth-state'
import { scopeState } from '../state/scope-state'

const copyState = ref('')
const keyLoading = ref(false)
const keyError = ref('')
const verifyLoading = ref(false)
const verifyError = ref('')
const verifyResult = ref(null)

const runtimeApiBaseUrl = 'https://runtime.example.com'
const placementId = 'chat_from_answer_v1'

const rows = computed(() => (Array.isArray(apiKeysState.items) ? apiKeysState.items : []))
const latestKey = computed(() => rows.value[0] || null)
const revealedSecret = computed(() => String(apiKeysState.meta.lastRevealedSecret || '').trim())
const embeddedAppId = computed(() => String(scopeState.appId || 'app_auto_assigned').trim())
const hasAvailableKey = computed(() => rows.value.length > 0)
const onboardingVerified = computed(() => authState.onboarding.status === 'verified')

const envSnippet = computed(() => `MEDIATION_RUNTIME_API_BASE_URL=${runtimeApiBaseUrl}\nMEDIATION_API_KEY=${revealedSecret.value || '<generated_in_step_a>'}`)

const integrationSnippet = computed(() => `const baseUrl = process.env.MEDIATION_RUNTIME_API_BASE_URL;
const apiKey = process.env.MEDIATION_API_KEY;
const appId = '${embeddedAppId.value}';
const placementId = '${placementId}';

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
console.log({ requestId: bidJson.requestId, message: bidJson.message });`)

const verifyEvidence = computed(() => (
  verifyResult.value ? JSON.stringify(verifyResult.value, null, 2) : ''
))

const onboardingStatusClass = computed(() => (
  onboardingVerified.value ? 'meta-pill good' : 'meta-pill warn'
))

const onboardingStatusLabel = computed(() => (
  onboardingVerified.value ? 'Verified' : 'Locked'
))

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
    await hydrateApiKeys()
  } catch (error) {
    keyError.value = error instanceof Error ? error.message : 'Key generation failed'
  } finally {
    keyLoading.value = false
  }
}

async function runQuickStartVerifier() {
  verifyLoading.value = true
  verifyError.value = ''
  verifyResult.value = null

  try {
    const payload = await controlPlaneClient.quickStart.verify()
    verifyResult.value = payload

    const status = String(payload?.status || '').trim().toLowerCase()
    if (status === 'verified' || payload?.ok === true || payload?.requestId) {
      markOnboardingVerified(payload?.verifiedAt)
    }
  } catch (error) {
    verifyError.value = error instanceof Error ? error.message : 'Verifier failed'
  } finally {
    verifyLoading.value = false
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
        <p class="subtitle">Complete setup in three steps.</p>
      </div>
      <div class="header-actions">
        <span :class="onboardingStatusClass">{{ onboardingStatusLabel }}</span>
      </div>
    </header>

    <article class="panel">
      <div class="panel-toolbar">
        <h3>Step A: Generate key</h3>
        <button class="button" type="button" :disabled="keyLoading || !scopeState.accountId" @click="createFirstKey">
          {{ keyLoading ? 'Generating...' : 'Generate key' }}
        </button>
      </div>
      <p class="muted">Account <strong>{{ scopeState.accountId || '-' }}</strong></p>
      <p class="muted">App <strong>{{ scopeState.appId || 'Auto-assigned on first key' }}</strong></p>
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
        <h3>Step B: Copy env</h3>
        <button class="button" type="button" @click="copyText(envSnippet)">
          Copy env
        </button>
      </div>
      <pre class="code-block">{{ envSnippet }}</pre>
      <p class="muted">Only two env vars are required.</p>
      <p class="muted">Embedded defaults: <code>appId={{ embeddedAppId }}</code> · <code>placementId={{ placementId }}</code></p>

      <div class="panel-toolbar">
        <h3>Runtime call</h3>
        <button class="button button-secondary" type="button" @click="copyText(integrationSnippet)">Copy snippet</button>
      </div>
      <pre class="code-block">{{ integrationSnippet }}</pre>
      <p v-if="copyState" class="copy-note">{{ copyState }}</p>
    </article>

    <article class="panel">
      <div class="panel-toolbar">
        <h3>Step C: Run verify</h3>
        <button class="button" type="button" :disabled="verifyLoading || !hasAvailableKey" @click="runQuickStartVerifier">
          {{ verifyLoading ? 'Verifying...' : 'Run verify' }}
        </button>
      </div>
      <p class="subtitle">No parameters required. Scope is resolved from your session.</p>
      <p v-if="verifyError" class="muted">{{ verifyError }}</p>
      <div v-if="verifyResult" class="verify-evidence">
        <p><strong>requestId:</strong> <code>{{ verifyResult.requestId || '-' }}</code></p>
        <p><strong>status:</strong> <code>{{ verifyResult.status || '-' }}</code></p>
        <pre class="code-block">{{ verifyEvidence }}</pre>
      </div>
    </article>

    <article class="panel">
      <h3>Pass criteria</h3>
      <ul class="checklist">
        <li>Key generated successfully (Step A)</li>
        <li>Env copied with only 2 variables (Step B)</li>
        <li>Verify returns request evidence (Step C)</li>
        <li>Navigation unlocks after verify</li>
      </ul>
    </article>
  </section>
</template>
