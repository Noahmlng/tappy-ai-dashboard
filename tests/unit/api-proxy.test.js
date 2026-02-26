import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import dashboardApiProxyHandler, {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  normalizeUpstreamBaseUrl,
  resolveUpstreamBaseUrl,
} from '../../api/[...path].js'

function createMockRes() {
  const headers = {}
  return {
    statusCode: 0,
    body: '',
    headers,
    setHeader(key, value) {
      headers[String(key).toLowerCase()] = value
    },
    end(payload) {
      this.body = payload ? String(payload) : ''
    },
  }
}

function createMockReq(url = '/api/v1/dashboard/state', method = 'GET', headers = {}) {
  return {
    url,
    method,
    headers,
    [Symbol.asyncIterator]: async function* iterator() {
      yield ''
    },
  }
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.restoreAllMocks()
})

describe('api proxy helpers', () => {
  it('normalizes upstream base url with /api suffix', () => {
    expect(normalizeUpstreamBaseUrl('https://control-plane.example.com'))
      .toBe('https://control-plane.example.com/api')
    expect(normalizeUpstreamBaseUrl('https://control-plane.example.com/api'))
      .toBe('https://control-plane.example.com/api')
  })

  it('builds upstream url by removing local /api prefix', () => {
    const url = buildUpstreamUrl(
      createMockReq('/api/v1/dashboard/state?accountId=org_1'),
      'https://control-plane.example.com/api',
    )
    expect(url).toBe('https://control-plane.example.com/api/v1/dashboard/state?accountId=org_1')
  })

  it('resolves env candidates in expected order', () => {
    expect(resolveUpstreamBaseUrl({
      MEDIATION_CONTROL_PLANE_API_BASE_URL: 'https://prod.example.com',
      MEDIATION_CONTROL_PLANE_API_PROXY_TARGET: 'http://127.0.0.1:3100',
    })).toBe('https://prod.example.com/api')
  })

  it('strips browser-only cors headers and keeps server-relevant headers', () => {
    const headers = buildUpstreamHeaders(createMockReq('/api/v1/dashboard/state', 'GET', {
      origin: 'https://dashboard.example.com',
      referer: 'https://dashboard.example.com/home',
      'sec-fetch-site': 'same-origin',
      cookie: 'dash_session=s1',
      authorization: 'Bearer x',
    }))

    expect(headers.origin).toBeUndefined()
    expect(headers.referer).toBeUndefined()
    expect(headers['sec-fetch-site']).toBeUndefined()
    expect(headers.cookie).toBe('dash_session=s1')
    expect(headers.authorization).toBe('Bearer x')
    expect(headers['x-forwarded-origin']).toBe('https://dashboard.example.com')
  })
})

describe('dashboardApiProxyHandler', () => {
  it('returns explicit error when upstream target is missing', async () => {
    delete process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET

    const res = createMockRes()
    await dashboardApiProxyHandler(createMockReq(), res)

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error.code).toBe('PROXY_TARGET_NOT_CONFIGURED')
  })

  it('returns timeout error code when fetch aborts', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com'

    const abortError = new Error('timeout')
    abortError.name = 'AbortError'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)

    const res = createMockRes()
    await dashboardApiProxyHandler(createMockReq(), res)

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error.code).toBe('PROXY_UPSTREAM_TIMEOUT')
  })

  it('passes through multiple set-cookie headers', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com'

    const payload = JSON.stringify({ ok: true })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      headers: {
        getSetCookie() {
          return ['dash_session=s1; Path=/', 'dash_csrf=c1; Path=/']
        },
        entries() {
          return new Map([
            ['content-type', 'application/json; charset=utf-8'],
            ['set-cookie', 'dash_session=s1; Path=/'],
          ]).entries()
        },
      },
      async arrayBuffer() {
        return new TextEncoder().encode(payload).buffer
      },
    })

    const res = createMockRes()
    await dashboardApiProxyHandler(createMockReq('/api/v1/dashboard/state', 'GET', {
      origin: 'https://dashboard.example.com',
      referer: 'https://dashboard.example.com/home',
      cookie: 'dash_session=s1',
    }), res)

    const [, requestOptions] = fetchMock.mock.calls[0]

    expect(res.statusCode).toBe(200)
    expect(res.headers['set-cookie']).toEqual(['dash_session=s1; Path=/', 'dash_csrf=c1; Path=/'])
    expect(res.body).toBe(payload)
    expect(requestOptions.headers.origin).toBeUndefined()
    expect(requestOptions.headers.referer).toBeUndefined()
    expect(requestOptions.headers.cookie).toBe('dash_session=s1')
    expect(requestOptions.headers['x-forwarded-origin']).toBe('https://dashboard.example.com')
  })
})
