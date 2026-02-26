<script setup>
import { computed, onMounted, ref } from 'vue'

import {
  apiKeysState,
  clearRevealedSecret,
  createApiKey,
  hydrateApiKeys,
  revokeApiKey,
  rotateApiKey,
} from '../state/api-keys-state'
import { scopeState } from '../state/scope-state'

const isBusy = computed(() => Boolean(apiKeysState.meta.loading || apiKeysState.meta.syncing))
const rows = computed(() => (Array.isArray(apiKeysState.items) ? apiKeysState.items : []))
const createError = ref('')

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function statusClass(status) {
  return status === 'revoked' ? 'status-pill bad' : 'status-pill good'
}

async function handleCreate() {
  createError.value = ''
  clearRevealedSecret()
  const result = await createApiKey({})
  if (!result?.ok) {
    createError.value = String(result?.error || 'Create key failed')
    return
  }
  await hydrateApiKeys()
}

async function handleRotate(keyId) {
  await rotateApiKey(keyId)
}

async function handleRevoke(keyId) {
  await revokeApiKey(keyId)
}

async function refreshKeys() {
  await hydrateApiKeys()
}

onMounted(() => {
  refreshKeys()
})
</script>

<template>
  <section class="page">
    <header class="page-header page-header-split">
      <div class="header-stack">
        <p class="eyebrow">Keys</p>
        <h2>Key</h2>
        <p class="subtitle">One-click generation with auto scope assignment.</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="isBusy" @click="refreshKeys()">
          {{ isBusy ? 'Sync...' : 'Sync' }}
        </button>
      </div>
    </header>

    <article class="panel create-key-form">
      <h3>Scope</h3>
      <p class="muted">Account <strong>{{ scopeState.accountId || '-' }}</strong></p>
      <p class="muted">App <strong>{{ scopeState.appId || 'Auto-assigned on first key' }}</strong></p>
    </article>

    <article class="panel">
      <div class="panel-toolbar">
        <h3>Create</h3>
        <button class="button" type="button" :disabled="isBusy || !scopeState.accountId" @click="handleCreate">
          {{ isBusy ? 'Creating...' : 'Generate key' }}
        </button>
      </div>
      <p class="muted">No optional parameters required.</p>
      <p v-if="createError" class="muted">{{ createError }}</p>
      <div v-if="apiKeysState.meta.lastRevealedSecret" class="secret-banner">
        <strong>Secret (once)</strong>
        <code>{{ apiKeysState.meta.lastRevealedSecret }}</code>
      </div>
    </article>

    <article class="panel panel-soft">
      <div class="panel-toolbar">
        <h3>Keys</h3>
        <p class="muted">{{ rows.length }}</p>
      </div>
      <p class="muted" v-if="apiKeysState.meta.error">{{ apiKeysState.meta.error }}</p>

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
            <tr v-for="row in rows" :key="row.keyId">
              <td>{{ row.name }}</td>
              <td>
                <span :class="statusClass(row.status)">
                  {{ row.status }}
                </span>
              </td>
              <td><code>{{ row.maskedKey }}</code></td>
              <td>{{ formatDate(row.createdAt) }}</td>
              <td>
                <div class="toolbar-actions">
                  <button
                    class="button button-secondary"
                    type="button"
                    :disabled="isBusy || row.status === 'revoked'"
                    @click="handleRotate(row.keyId)"
                  >
                    Rotate
                  </button>
                  <button
                    class="button button-danger"
                    type="button"
                    :disabled="isBusy || row.status === 'revoked'"
                    @click="handleRevoke(row.keyId)"
                  >
                    Revoke
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="rows.length === 0">
              <td colspan="5" class="muted">No keys.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </section>
</template>
