import { afterEach, describe, expect, it, vi } from 'vitest'

import { appendQuery, controlPlaneClient, getCookieValue, setDashboardAccessToken } from '../../src/api/control-plane-client'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'window')
  setDashboardAccessToken('')
})

describe('control-plane-client helpers', () => {
  it('builds query suffix deterministically', () => {
    expect(appendQuery('/v1/dashboard/state', { accountId: 'org_a', appId: 'app_a' }))
      .toBe('/v1/dashboard/state?accountId=org_a&appId=app_a')
    expect(appendQuery('/v1/dashboard/state', { accountId: '', appId: null }))
      .toBe('/v1/dashboard/state')
  })

  it('reads cookie values safely', () => {
    expect(getCookieValue('dash_csrf', 'a=1; dash_csrf=csrf%2Btoken; b=2')).toBe('csrf+token')
    expect(getCookieValue('missing', 'a=1; b=2')).toBe('')
  })
})

describe('control-plane-client runtime behavior', () => {
  it('attaches csrf header on write methods', async () => {
    globalThis.document = {
      cookie: 'dash_csrf=csrf-token',
    }

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true }))

    await controlPlaneClient.auth.logout()

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/public/dashboard/logout')
    expect(options.method).toBe('POST')
    expect(options.headers['x-csrf-token']).toBe('csrf-token')
  })

  it('does not attach csrf header on read methods', async () => {
    globalThis.document = {
      cookie: 'dash_csrf=csrf-token',
    }

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ placements: [] }))

    await controlPlaneClient.placements.list({})

    const [, options] = fetchMock.mock.calls[0]
    expect(options.method).toBe('GET')
    expect(options.headers['x-csrf-token']).toBeUndefined()
  })

  it('does not auto-attach bearer token for dashboard cookie auth requests', async () => {
    setDashboardAccessToken('dsh_test_token')

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true }))

    await controlPlaneClient.dashboard.getState({})

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBeUndefined()
  })

  it('retries once with bearer token when cookie auth returns 401', async () => {
    const storage = new Map()
    globalThis.window = {
      localStorage: {
        getItem(key) {
          return storage.get(String(key)) ?? null
        },
        setItem(key, value) {
          storage.set(String(key), String(value))
        },
        removeItem(key) {
          storage.delete(String(key))
        },
      },
    }
    setDashboardAccessToken('dsh_retry_token')

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        error: { code: 'AUTH_REQUIRED', message: 'auth required' },
      }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    await controlPlaneClient.dashboard.getState({})

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, firstOptions] = fetchMock.mock.calls[0]
    const [, secondOptions] = fetchMock.mock.calls[1]
    expect(firstOptions.headers.Authorization).toBeUndefined()
    expect(secondOptions.headers.Authorization).toBe('Bearer dsh_retry_token')
  })

  it('supports quick-start verify with empty payload', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ status: 'verified', requestId: 'req_1' }))

    await controlPlaneClient.quickStart.verify()

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/public/quick-start/verify')
    expect(options.method).toBe('POST')
    expect(options.body).toBe('{}')
  })

  it('supports runtime-domain verify with explicit runtime api key header', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ status: 'verified', requestId: 'req_bind_1' }))

    await controlPlaneClient.runtimeDomain.verifyAndBind({
      domain: 'runtime.customer-example.org',
    }, {
      apiKey: 'sk_runtime_secret',
    })

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/public/runtime-domain/verify-and-bind')
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Bearer sk_runtime_secret')
    expect(options.headers['x-csrf-token']).toBeUndefined()
    expect(options.body).toBe('{\"domain\":\"runtime.customer-example.org\"}')
  })

  it('supports runtime-domain probe with explicit runtime api key header', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({
        status: 'pending',
        finalStatus: 'pending',
        requestId: 'req_probe_1',
      }))

    await controlPlaneClient.runtimeDomain.probe({
      domain: 'https://runtime.customer-example.org',
      runBrowserProbe: true,
      browserProbe: {
        ok: true,
        code: 'VERIFIED',
      },
    }, {
      apiKey: 'sk_runtime_secret',
    })

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/public/runtime-domain/probe')
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Bearer sk_runtime_secret')
    expect(options.headers['x-csrf-token']).toBeUndefined()
    expect(options.body).toContain('\"runBrowserProbe\":true')
  })

  it('supports sdk bootstrap with explicit runtime api key header', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({
        runtimeBaseUrl: 'https://runtime.customer-example.org',
        tenantId: 'tenant_1',
        keyScope: 'tenant',
      }))

    await controlPlaneClient.sdk.bootstrap({
      apiKey: 'sk_runtime_secret',
    })

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/public/sdk/bootstrap')
    expect(options.method).toBe('GET')
    expect(options.headers.Authorization).toBe('Bearer sk_runtime_secret')
  })

  it('normalizes error payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      error: {
        code: 'AUTH_INVALID',
        message: 'bad auth',
      },
    }, 401))

    await expect(controlPlaneClient.auth.me()).rejects.toMatchObject({
      name: 'ControlPlaneApiError',
      status: 401,
      code: 'AUTH_INVALID',
      message: 'bad auth',
    })
  })
})
