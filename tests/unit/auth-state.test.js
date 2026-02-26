import { afterEach, describe, expect, it, vi } from 'vitest'

import { controlPlaneClient, setDashboardAccessToken } from '../../src/api/control-plane-client'
import {
  authState,
  isOnboardingVerified,
  loginDashboardUser,
  registerDashboardUser,
} from '../../src/state/auth-state'
import { setScope, scopeState } from '../../src/state/scope-state'

function resetAuthState() {
  authState.user = null
  authState.session = null
  authState.onboarding.status = 'locked'
  authState.onboarding.verifiedAt = ''
  authState.authenticated = false
  authState.ready = false
  authState.loading = false
  authState.error = ''
  setDashboardAccessToken('')
  setScope({ accountId: '', appId: '' })
}

afterEach(() => {
  vi.restoreAllMocks()
  resetAuthState()
})

describe('auth-state onboarding behavior', () => {
  it('register keeps onboarding locked when backend marks locked', async () => {
    vi.spyOn(controlPlaneClient.auth, 'register').mockResolvedValue({
      user: { email: 'new@example.com', accountId: 'org_new' },
      session: { id: 'sess_1' },
      scope: { accountId: 'org_new', appId: '' },
      onboarding: { status: 'locked' },
    })

    await registerDashboardUser({
      email: 'new@example.com',
      password: 'password-123',
    })

    expect(scopeState.accountId).toBe('org_new')
    expect(scopeState.appId).toBe('')
    expect(authState.onboarding.status).toBe('locked')
    expect(isOnboardingVerified()).toBe(false)
  })

  it('login marks onboarding verified from payload', async () => {
    vi.spyOn(controlPlaneClient.auth, 'login').mockResolvedValue({
      user: { email: 'verified@example.com', accountId: 'org_v', appId: 'app_v' },
      session: { id: 'sess_2' },
      scope: { accountId: 'org_v', appId: 'app_v' },
      onboarding: { status: 'verified', verifiedAt: '2026-02-26T10:00:00.000Z' },
    })

    await loginDashboardUser({
      email: 'verified@example.com',
      password: 'password-123',
    })

    expect(authState.onboarding.status).toBe('verified')
    expect(authState.onboarding.verifiedAt).toBe('2026-02-26T10:00:00.000Z')
    expect(isOnboardingVerified()).toBe(true)
  })

  it('infers verified onboarding for legacy payloads with account+app scope', async () => {
    vi.spyOn(controlPlaneClient.auth, 'login').mockResolvedValue({
      user: { email: 'legacy@example.com', accountId: 'org_legacy', appId: 'app_legacy' },
      session: { id: 'sess_3' },
      scope: { accountId: 'org_legacy', appId: 'app_legacy' },
    })

    await loginDashboardUser({
      email: 'legacy@example.com',
      password: 'password-123',
    })

    expect(authState.onboarding.status).toBe('verified')
    expect(isOnboardingVerified()).toBe(true)
  })
})
