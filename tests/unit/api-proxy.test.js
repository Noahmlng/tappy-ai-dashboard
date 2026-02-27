import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import dashboardApiProxyHandler, {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  normalizeBidPayload,
  normalizeUpstreamBaseUrl,
  resolveRuntimeApiBaseUrl,
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
    body: undefined,
    [Symbol.asyncIterator]: async function* iterator() {
      yield ''
    },
  }
}

function createJsonUpstreamResponse(payload = {}, status = 200) {
  const body = JSON.stringify(payload)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      getSetCookie() {
        return []
      },
      get(name) {
        const normalizedName = String(name || '').toLowerCase()
        if (normalizedName === 'content-type') return 'application/json; charset=utf-8'
        return null
      },
      entries() {
        return new Map([
          ['content-type', 'application/json; charset=utf-8'],
        ]).entries()
      },
    },
    async json() {
      return payload
    },
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer
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

  it('resolves control-plane and runtime upstream envs', () => {
    expect(resolveUpstreamBaseUrl({
      MEDIATION_CONTROL_PLANE_API_BASE_URL: 'https://cp.example.com',
    })).toBe('https://cp.example.com/api')

    expect(resolveRuntimeApiBaseUrl({
      MEDIATION_RUNTIME_API_BASE_URL: 'https://rt.example.com',
    })).toBe('https://rt.example.com/api')

    expect(resolveRuntimeApiBaseUrl({
      MEDIATION_CONTROL_PLANE_API_BASE_URL: 'https://cp.example.com',
    })).toBe('https://cp.example.com/api')
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

  it('normalizes bid payload landing url from fallback fields', () => {
    const fromLink = normalizeBidPayload({
      requestId: 'req_1',
      link: 'https://ad.example.com/a',
    })
    expect(fromLink.landingUrl).toBe('https://ad.example.com/a')
    expect(fromLink.payload.landingUrl).toBe('https://ad.example.com/a')
  })
})

describe('dashboardApiProxyHandler', () => {
  it('returns explicit error when control-plane target is missing', async () => {
    delete process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET

    const res = createMockRes()
    await dashboardApiProxyHandler(createMockReq(), res)

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error.code).toBe('PROXY_TARGET_NOT_CONFIGURED')
  })

  it('returns 410 for removed bootstrap and bind routes', async () => {
    const removedRoutes = [
      ['/api/v1/public/sdk/bootstrap', 'GET', 'BOOTSTRAP_REMOVED'],
      ['/api/v1/public/runtime-domain/verify-and-bind', 'POST', 'RUNTIME_BIND_FLOW_REMOVED'],
      ['/api/v1/public/runtime-domain/probe', 'POST', 'RUNTIME_BIND_FLOW_REMOVED'],
      ['/api/ad/bid', 'POST', 'AD_BID_ROUTE_REMOVED'],
    ]

    for (const [pathname, method, code] of removedRoutes) {
      const res = createMockRes()
      await dashboardApiProxyHandler(createMockReq(pathname, method), res)
      expect(res.statusCode).toBe(410)
      expect(JSON.parse(res.body).error.code).toBe(code)
    }
  })

  it('proxies /api/v2/bid directly to runtime API base URL', async () => {
    process.env.MEDIATION_RUNTIME_API_BASE_URL = 'https://runtime.example.com'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonUpstreamResponse({
      requestId: 'req_runtime_1',
      url: 'https://ads.customer.example/deal',
    }))

    const req = createMockReq('/api/v2/bid', 'POST', {
      authorization: 'Bearer sk_runtime_1',
      'content-type': 'application/json',
    })
    req.body = {
      messages: [{ role: 'user', content: 'show me deals' }],
    }

    const res = createMockRes()
    await dashboardApiProxyHandler(req, res)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://runtime.example.com/api/v2/bid',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-tappy-runtime-source']).toBe('runtime_api_base_url')
    expect(JSON.parse(res.body)).toMatchObject({
      requestId: 'req_runtime_1',
      landingUrl: 'https://ads.customer.example/deal',
    })
  })

  it('returns explicit error when runtime target is missing for /api/v2/bid', async () => {
    delete process.env.MEDIATION_RUNTIME_API_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET

    const req = createMockReq('/api/v2/bid', 'POST', {
      authorization: 'Bearer sk_runtime_1',
      'content-type': 'application/json',
    })
    req.body = {
      messages: [{ role: 'user', content: 'show me deals' }],
    }

    const res = createMockRes()
    await dashboardApiProxyHandler(req, res)

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error.code).toBe('PROXY_RUNTIME_TARGET_NOT_CONFIGURED')
  })

  it('falls back to control-plane base URL for /api/v2/bid when runtime env is missing', async () => {
    delete process.env.MEDIATION_RUNTIME_API_BASE_URL
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://cp.example.com'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonUpstreamResponse({
      requestId: 'req_runtime_2',
      url: 'https://ads.customer.example/deal-2',
    }))

    const req = createMockReq('/api/v2/bid', 'POST', {
      authorization: 'Bearer sk_runtime_2',
      'content-type': 'application/json',
    })
    req.body = {
      messages: [{ role: 'user', content: 'find a deal' }],
    }

    const res = createMockRes()
    await dashboardApiProxyHandler(req, res)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.example.com/api/v2/bid',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-tappy-runtime-source']).toBe('runtime_api_base_url')
    expect(JSON.parse(res.body)).toMatchObject({
      requestId: 'req_runtime_2',
      landingUrl: 'https://ads.customer.example/deal-2',
    })
  })

  it('does not inject placementId for quick-start verify payload', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://cp.example.com'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonUpstreamResponse({ ok: true }))

    const req = createMockReq('/api/v1/public/quick-start/verify', 'POST', {
      authorization: 'Bearer dashboard_access',
      'content-type': 'application/json',
    })
    req.body = {
      accountId: 'org_demo',
      appId: 'app_demo',
      environment: 'prod',
    }

    const res = createMockRes()
    await dashboardApiProxyHandler(req, res)

    const [, init] = fetchMock.mock.calls[0]
    const payload = JSON.parse(String(init.body || '{}'))
    expect(Object.prototype.hasOwnProperty.call(payload, 'placementId')).toBe(false)
    expect(payload).toMatchObject({
      accountId: 'org_demo',
      appId: 'app_demo',
      environment: 'prod',
    })
  })

  it('keeps generic control-plane proxy forwarding intact', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://cp.example.com'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createJsonUpstreamResponse({ ok: true }))

    const res = createMockRes()
    await dashboardApiProxyHandler(createMockReq('/api/v1/dashboard/state?accountId=org_1', 'GET'), res)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cp.example.com/api/v1/dashboard/state?accountId=org_1',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true })
  })
})
