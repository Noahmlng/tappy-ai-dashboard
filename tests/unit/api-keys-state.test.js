import { afterEach, describe, expect, it, vi } from 'vitest'

import { controlPlaneClient } from '../../src/api/control-plane-client'
import { apiKeysState, createApiKey } from '../../src/state/api-keys-state'
import { setScope, scopeState } from '../../src/state/scope-state'

function resetApiKeysState() {
  apiKeysState.items = []
  apiKeysState.meta.loading = false
  apiKeysState.meta.syncing = false
  apiKeysState.meta.syncMode = 'unknown'
  apiKeysState.meta.error = ''
  apiKeysState.meta.lastSyncedAt = ''
  apiKeysState.meta.lastRevealedSecret = ''
  setScope({ accountId: '', appId: '' })
}

afterEach(() => {
  vi.restoreAllMocks()
  resetApiKeysState()
})

describe('api-keys-state create behavior', () => {
  it('supports create without appId and writes returned scope appId', async () => {
    setScope({ accountId: 'org_auto', appId: '' })

    const createSpy = vi.spyOn(controlPlaneClient.credentials, 'createKey').mockResolvedValue({
      key: {
        keyId: 'key_1',
        accountId: 'org_auto',
        appId: 'app_auto',
        name: 'runtime-prod',
        environment: 'prod',
        status: 'active',
        maskedKey: 'sk_live_****',
        createdAt: '2026-02-26T11:00:00.000Z',
      },
      scope: {
        accountId: 'org_auto',
        appId: 'app_auto',
      },
      secret: 'sk_live_secret',
    })

    const result = await createApiKey({})
    const payload = createSpy.mock.calls[0][0]

    expect(payload.accountId).toBe('org_auto')
    expect(payload.appId).toBeUndefined()
    expect(payload.environment).toBe('prod')
    expect(payload.name).toBe('runtime-prod')

    expect(result.ok).toBe(true)
    expect(scopeState.appId).toBe('app_auto')
    expect(apiKeysState.meta.lastRevealedSecret).toBe('sk_live_secret')
    expect(apiKeysState.items[0]?.keyId).toBe('key_1')
  })

  it('marks requiresLogin on 401/403 create failures', async () => {
    setScope({ accountId: 'org_auto', appId: '' })
    vi.spyOn(controlPlaneClient.credentials, 'createKey').mockRejectedValue(
      Object.assign(new Error('Dashboard authentication is required.'), {
        status: 401,
        code: 'AUTH_REQUIRED',
      }),
    )

    const result = await createApiKey({})

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.code).toBe('AUTH_REQUIRED')
    expect(result.requiresLogin).toBe(true)
  })

  it('keeps non-auth upstream failures as non-login errors', async () => {
    setScope({ accountId: 'org_auto', appId: '' })
    vi.spyOn(controlPlaneClient.credentials, 'createKey').mockRejectedValue(
      Object.assign(new Error('service unavailable'), {
        status: 503,
        code: 'UPSTREAM_DOWN',
      }),
    )

    const result = await createApiKey({})

    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.code).toBe('UPSTREAM_DOWN')
    expect(result.requiresLogin).toBe(false)
  })
})
