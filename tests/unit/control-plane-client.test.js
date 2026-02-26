import { afterEach, describe, expect, it, vi } from 'vitest'

import { appendQuery, controlPlaneClient, getCookieValue } from '../../src/api/control-plane-client'

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
