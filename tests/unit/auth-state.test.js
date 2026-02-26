import { afterEach, describe, expect, it, vi } from 'vitest'

import { controlPlaneClient, setDashboardAccessToken } from '../../src/api/control-plane-client'
import {
  authState,
  isOnboardingUnlocked,
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
    expect(isOnboardingUnlocked()).toBe(true)
  })

  it('login normalizes pending onboarding to locked while keeping auth unlocked', async () => {
    vi.spyOn(controlPlaneClient.auth, 'login').mockResolvedValue({
      user: { email: 'pending@example.com', accountId: 'org_p', appId: '' },
      session: { id: 'sess_pending' },
      scope: { accountId: 'org_p', appId: '' },
      onboarding: { status: 'pending' },
    })

    await loginDashboardUser({
      email: 'pending@example.com',
      password: 'password-123',
    })

    expect(authState.onboarding.status).toBe('locked')
    expect(isOnboardingUnlocked()).toBe(true)
    expect(isOnboardingVerified()).toBe(false)
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

  it('keeps dashboard requests on cookie auth even if top-level token exists', async () => {
    vi.spyOn(controlPlaneClient.auth, 'login').mockResolvedValue({
      user: { email: 'token@example.com', accountId: 'org_token', appId: 'app_token' },
      session: { id: 'sess_4' },
      accessToken: 'dsh_top_level_token',
      scope: { accountId: 'org_token', appId: 'app_token' },
      onboarding: { status: 'verified' },
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }))

    await loginDashboardUser({
      email: 'token@example.com',
      password: 'password-123',
    })

    await controlPlaneClient.dashboard.getState({})

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBeUndefined()
  })
})
