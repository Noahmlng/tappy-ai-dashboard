import { reactive } from 'vue'

import { controlPlaneClient, setDashboardAccessToken } from '../api/control-plane-client'
import { setScope } from './scope-state'

function normalizeOnboarding(source = {}) {
  const status = String(source?.status || '').trim().toLowerCase()
  return {
    status: status === 'verified' ? 'verified' : 'locked',
    verifiedAt: String(source?.verifiedAt || source?.verified_at || '').trim(),
  }
}

function pickScopeValue(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (normalized) return normalized
  }
  return ''
}

function resolveOnboarding(payload = {}, user = {}, scope = {}) {
  const explicit = normalizeOnboarding(payload?.onboarding || {})
  if (explicit.status === 'verified') return explicit

  const accountId = pickScopeValue(
    scope?.accountId,
    scope?.account_id,
    scope?.organizationId,
    scope?.organization_id,
    user?.accountId,
    user?.account_id,
    user?.organizationId,
    user?.organization_id,
  )
  const appId = pickScopeValue(
    scope?.appId,
    scope?.app_id,
    user?.appId,
    user?.app_id,
  )
  if (accountId && appId) {
    return {
      status: 'verified',
      verifiedAt: explicit.verifiedAt,
    }
  }

  return explicit
}

function applyScopeFromUser(user = {}, scope = {}) {
  const accountId = pickScopeValue(
    scope?.accountId,
    scope?.account_id,
    scope?.organizationId,
    scope?.organization_id,
    user?.accountId,
    user?.account_id,
    user?.organizationId,
    user?.organization_id,
  )
  const appId = pickScopeValue(
    scope?.appId,
    scope?.app_id,
    user?.appId,
    user?.app_id,
  )
  if (!accountId) return

  setScope({
    accountId,
    appId,
  })
}

function resolveAccessToken(payload = {}, session = {}) {
  return pickScopeValue(
    session?.accessToken,
    session?.access_token,
    session?.token,
    payload?.accessToken,
    payload?.access_token,
    payload?.token,
    payload?.sessionToken,
    payload?.auth?.accessToken,
    payload?.auth?.access_token,
    payload?.auth?.token,
  )
}

export const authState = reactive({
  user: null,
  session: null,
  onboarding: {
    status: 'locked',
    verifiedAt: '',
  },
  authenticated: false,
  ready: false,
  loading: false,
  error: '',
})

function applyAuthPayload(payload = {}) {
  const user = payload?.user && typeof payload.user === 'object' ? payload.user : null
  const session = payload?.session && typeof payload.session === 'object' ? payload.session : null
  const accessToken = resolveAccessToken(payload, session)
  const scope = payload?.scope && typeof payload.scope === 'object' ? payload.scope : {}
  const onboarding = resolveOnboarding(payload, user || {}, scope)

  authState.user = user
  authState.session = session
  authState.onboarding.status = onboarding.status
  authState.onboarding.verifiedAt = onboarding.verifiedAt
  authState.authenticated = Boolean(user)
  authState.error = ''
  authState.ready = true
  setDashboardAccessToken(accessToken)

  if (user) {
    applyScopeFromUser(user, scope)
  }
}

function clearAuthState() {
  authState.user = null
  authState.session = null
  authState.onboarding.status = 'locked'
  authState.onboarding.verifiedAt = ''
  authState.authenticated = false
  authState.error = ''
  authState.ready = true
  setDashboardAccessToken('')
}

export function isOnboardingVerified() {
  return authState.onboarding.status === 'verified'
}

export function markOnboardingVerified(verifiedAt = '') {
  authState.onboarding.status = 'verified'
  authState.onboarding.verifiedAt = String(verifiedAt || '').trim() || new Date().toISOString()
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
