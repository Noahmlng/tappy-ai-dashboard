<script setup>
import { computed, reactive, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { authState, registerDashboardUser } from '../state/auth-state'

const router = useRouter()
const submitError = ref('')

const draft = reactive({
  email: '',
  password: '',
})

const isBusy = computed(() => Boolean(authState.loading))

async function handleRegister() {
  submitError.value = ''
  try {
    await registerDashboardUser({
      email: draft.email,
      password: draft.password,
    })
    await router.replace('/onboarding')
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : 'Register failed'
  }
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <p class="eyebrow">Customer Access</p>
      <h2>Create Account</h2>
      <p class="subtitle">
        Create your account. Scope is assigned automatically.
      </p>
    </header>

    <article class="panel">
      <div class="form-grid">
        <label>
          Email
          <input v-model="draft.email" class="input" type="email" maxlength="120" autocomplete="email">
        </label>
        <label>
          Password (min 8 chars)
          <input
            v-model="draft.password"
            class="input"
            type="password"
            maxlength="120"
            autocomplete="new-password"
          >
        </label>
      </div>

      <div class="toolbar-actions">
        <button
          class="button"
          type="button"
          :disabled="isBusy || !draft.email.trim() || !draft.password"
          @click="handleRegister"
        >
          {{ isBusy ? 'Creating...' : 'Create Account' }}
        </button>
        <RouterLink class="button button-secondary" to="/login">
          Back to sign in
        </RouterLink>
      </div>
      <p v-if="submitError || authState.error" class="muted">
        {{ submitError || authState.error }}
      </p>
    </article>
  </section>
</template>
