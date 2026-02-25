import { reactive } from 'vue'

import { controlPlaneClient } from '../api/control-plane-client'
import { setScope } from './scope-state'

function applyScopeFromUser(user = {}, scope = {}) {
  const accountId = String(scope.accountId || user.accountId || '').trim()
  const appId = String(scope.appId || user.appId || '').trim()
  if (!accountId) return

  setScope({
    accountId,
    appId,
  })
}

export const authState = reactive({
  user: null,
  session: null,
  authenticated: false,
  ready: false,
  loading: false,
  error: '',
})

function applyAuthPayload(payload = {}) {
  const user = payload?.user && typeof payload.user === 'object' ? payload.user : null
  const session = payload?.session && typeof payload.session === 'object' ? payload.session : null

  authState.user = user
  authState.session = session
  authState.authenticated = Boolean(user)
  authState.error = ''
  authState.ready = true

  if (user) {
    applyScopeFromUser(user, payload?.scope || {})
  }
}

function clearAuthState() {
  authState.user = null
  authState.session = null
  authState.authenticated = false
  authState.error = ''
  authState.ready = true
}

export async function hydrateAuthSession() {
  authState.loading = true
  try {
    const payload = await controlPlaneClient.auth.me()
    applyAuthPayload(payload)
  } catch (error) {
    clearAuthState()
    const status = Number(error?.status || 0)
    if (status !== 401 && status !== 403) {
      authState.error = error instanceof Error ? error.message : 'Failed to restore session'
    }
  } finally {
    authState.loading = false
    authState.ready = true
  }
}

export async function registerDashboardUser(payload = {}) {
  authState.loading = true
  try {
    const response = await controlPlaneClient.auth.register(payload)
    applyAuthPayload(response)
    return response
  } finally {
    authState.loading = false
  }
}

export async function loginDashboardUser(payload = {}) {
  authState.loading = true
  try {
    const response = await controlPlaneClient.auth.login(payload)
    applyAuthPayload(response)
    return response
  } finally {
    authState.loading = false
  }
}

export async function logoutDashboardUser() {
  authState.loading = true
  try {
    await controlPlaneClient.auth.logout()
  } catch {
    // no-op: local state must still be cleared
  } finally {
    clearAuthState()
    authState.loading = false
  }
}
