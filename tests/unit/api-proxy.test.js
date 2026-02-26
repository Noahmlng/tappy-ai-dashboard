import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

import dashboardApiProxyHandler, {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  clearRuntimeDomainBindingsForTests,
  normalizeUpstreamBaseUrl,
  normalizeBidPayload,
  normalizeRuntimeDomain,
  resolveManagedRuntimeBaseUrl,
  resolveUpstreamBaseUrl,
  setRuntimeDepsForTests,
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
  clearRuntimeDomainBindingsForTests()
  setRuntimeDepsForTests(null)
})

describe('api proxy helpers', () => {
  it('normalizes upstream base url with /api suffix', () => {
    expect(normalizeUpstreamBaseUrl('https://control-plane.example.com'))
      .toBe('https://control-plane.example.com/api')
    expect(normalizeUpstreamBaseUrl('https://control-plane.example.com/api'))
      .toBe('https://control-plane.example.com/api')
    expect(normalizeUpstreamBaseUrl('https://control-plane.example.com/api\\n'))
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

  it('resolves managed runtime base url only from explicit runtime fallback env', () => {
    expect(resolveManagedRuntimeBaseUrl({
      MEDIATION_CONTROL_PLANE_API_BASE_URL: 'https://prod.example.com/api',
    })).toBe('')

    expect(resolveManagedRuntimeBaseUrl({
      MEDIATION_MANAGED_RUNTIME_BASE_URL: 'https://runtime-managed.example.com/base',
      MEDIATION_CONTROL_PLANE_API_BASE_URL: 'https://prod.example.com/api',
    })).toBe('https://runtime-managed.example.com/base')
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

  it('normalizes runtime domain and rejects unsafe placeholders', () => {
    expect(normalizeRuntimeDomain('customer-runtime.example.org')).toMatchObject({
      ok: true,
      hostname: 'customer-runtime.example.org',
      runtimeBaseUrl: 'https://customer-runtime.example.org',
    })
    expect(normalizeRuntimeDomain('https://runtime.example.com')).toMatchObject({
      ok: false,
      failureCode: 'CNAME_MISMATCH',
    })
    expect(normalizeRuntimeDomain('localhost')).toMatchObject({
      ok: false,
      failureCode: 'CNAME_MISMATCH',
    })
  })

  it('normalizes bid payload landing url from fallback fields', () => {
    const fromLink = normalizeBidPayload({
      requestId: 'req_1',
      link: 'https://ad.example.com/a',
    })
    expect(fromLink.landingUrl).toBe('https://ad.example.com/a')
    expect(fromLink.payload.landingUrl).toBe('https://ad.example.com/a')

    const fromMessage = normalizeBidPayload({
      requestId: 'req_2',
      message: 'Click https://ad.example.com/b now',
    })
    expect(fromMessage.landingUrl).toBe('https://ad.example.com/b')
  })
})

describe('dashboardApiProxyHandler', () => {
  function createTlsConnectStub() {
    return vi.fn(() => {
      const socket = new EventEmitter()
      socket.destroy = vi.fn()
      socket.end = vi.fn()
      setTimeout(() => {
        socket.emit('secureConnect')
      }, 0)
      return socket
    })
  }

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
            ['content-encoding', 'gzip'],
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
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body).toBe(payload)
    expect(requestOptions.headers.origin).toBeUndefined()
    expect(requestOptions.headers.referer).toBeUndefined()
    expect(requestOptions.headers.cookie).toBe('dash_session=s1')
    expect(requestOptions.headers['x-forwarded-origin']).toBe('https://dashboard.example.com')
  })

  it('falls back to set-cookie header parsing when getSetCookie is unavailable', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com'

    const payload = JSON.stringify({ ok: true })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      headers: {
        get(name) {
          if (String(name).toLowerCase() === 'set-cookie') {
            return 'dash_session=s1; Path=/; HttpOnly; Secure, dash_csrf=c1; Path=/; Secure'
          }
          return null
        },
        entries() {
          return new Map([
            ['content-type', 'application/json; charset=utf-8'],
            ['set-cookie', 'dash_session=s1; Path=/; HttpOnly; Secure'],
          ]).entries()
        },
      },
      async arrayBuffer() {
        return new TextEncoder().encode(payload).buffer
      },
    })

    const res = createMockRes()
    await dashboardApiProxyHandler(createMockReq('/api/v1/public/dashboard/login', 'POST', {
      'content-type': 'application/json',
    }), res)

    expect(res.statusCode).toBe(200)
    expect(res.headers['set-cookie']).toEqual([
      'dash_session=s1; Path=/; HttpOnly; Secure',
      'dash_csrf=c1; Path=/; Secure',
    ])
  })

  it('enriches quick-start verify payload from session scope when backend expects scope fields', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const normalizedUrl = String(url)
      if (normalizedUrl.endsWith('/api/v1/public/dashboard/me')) {
        return createJsonUpstreamResponse({
          scope: { organizationId: 'org_auto', app_id: 'app_auto' },
        })
      }
      if (normalizedUrl.endsWith('/api/v1/public/quick-start/verify')) {
        return createJsonUpstreamResponse({
          status: 'verified',
          requestId: 'req_1',
        })
      }
      throw new Error(`Unexpected upstream URL: ${normalizedUrl}`)
    })

    const req = createMockReq('/api/v1/public/quick-start/verify', 'POST', {
      'content-type': 'application/json',
      cookie: 'dash_session=s1',
    })
    req.body = {}

    const res = createMockRes()
    await dashboardApiProxyHandler(req, res)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, verifyOptions] = fetchMock.mock.calls[1]
    expect(JSON.parse(String(verifyOptions.body || '{}'))).toMatchObject({
      accountId: 'org_auto',
      appId: 'app_auto',
      environment: 'prod',
      placementId: 'chat_from_answer_v1',
    })
    expect(res.statusCode).toBe(200)
  })

  it('enriches create-key payload with defaults and inferred scope', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const normalizedUrl = String(url)
      if (normalizedUrl.endsWith('/api/v1/public/dashboard/me')) {
        return createJsonUpstreamResponse({
          scope: { account_id: 'org_auto', appId: 'app_auto' },
        })
      }
      if (normalizedUrl.endsWith('/api/v1/public/credentials/keys')) {
        return createJsonUpstreamResponse({
          key: { keyId: 'key_1' },
        })
      }
      throw new Error(`Unexpected upstream URL: ${normalizedUrl}`)
    })

    const req = createMockReq('/api/v1/public/credentials/keys', 'POST', {
      'content-type': 'application/json',
      cookie: 'dash_session=s1',
    })
    req.body = {}

    const res = createMockRes()
    await dashboardApiProxyHandler(req, res)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, createOptions] = fetchMock.mock.calls[1]
    expect(JSON.parse(String(createOptions.body || '{}'))).toMatchObject({
      accountId: 'org_auto',
      appId: 'app_auto',
      environment: 'prod',
      name: 'runtime-prod',
    })
    expect(res.statusCode).toBe(200)
  })

  it('auto-generates accountId for register payload when legacy backend requires it', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createJsonUpstreamResponse({ ok: true }),
    )

    const req = createMockReq('/api/v1/public/dashboard/register', 'POST', {
      'content-type': 'application/json',
    })
    req.body = {
      email: 'demo.user@example.com',
      password: 'secret',
    }

    const res = createMockRes()
    await dashboardApiProxyHandler(req, res)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, registerOptions] = fetchMock.mock.calls[0]
    const payload = JSON.parse(String(registerOptions.body || '{}'))
    expect(payload.email).toBe('demo.user@example.com')
    expect(payload.password).toBe('secret')
    expect(payload.accountId).toMatch(/^org_demo_user_[a-z0-9]{6}$/)
    expect(res.statusCode).toBe(200)
  })

  it('verifies and binds runtime domain, then serves sdk bootstrap config', async () => {
    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['203.0.113.11']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue(['runtime-gateway.tappy.ai']),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn().mockResolvedValue(createJsonUpstreamResponse({
        requestId: 'req_bid_probe',
        url: 'https://ads.customer.example/landing',
      })),
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_1',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'runtime.customer-example.org',
      placementId: 'chat_from_answer_v1',
    }

    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)

    expect(verifyRes.statusCode).toBe(200)
    const verifyPayload = JSON.parse(verifyRes.body)
    expect(verifyPayload.status).toBe('verified')
    expect(verifyPayload.bindStage).toBe('bound')
    expect(verifyPayload.runtimeBaseUrl).toBe('https://runtime.customer-example.org')
    expect(verifyPayload.checks).toMatchObject({
      dnsOk: true,
      cnameOk: true,
      tlsOk: true,
      connectOk: true,
      authOk: true,
      bidOk: true,
      landingUrlOk: true,
    })

    const bootstrapReq = createMockReq('/api/v1/public/sdk/bootstrap', 'GET', {
      authorization: 'Bearer sk_runtime_1',
    })
    const bootstrapRes = createMockRes()
    await dashboardApiProxyHandler(bootstrapReq, bootstrapRes)
    expect(bootstrapRes.statusCode).toBe(200)
    expect(JSON.parse(bootstrapRes.body)).toMatchObject({
      runtimeBaseUrl: 'https://runtime.customer-example.org',
      keyScope: 'tenant',
      bindStatus: 'verified',
      placementDefaults: {
        placementId: 'chat_from_answer_v1',
      },
    })
  })

  it('allows direct runtime domain without gateway cname in default mode', async () => {
    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['31.13.85.34']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue(['cname.vercel-dns.com']),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn().mockResolvedValue(createJsonUpstreamResponse({
        requestId: 'req_bid_probe_2',
        message: 'Open https://ads.customer.example/direct',
      })),
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_direct',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'simple-chatbot-phi.vercel.app',
      placementId: 'chat_from_answer_v1',
    }

    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)

    const payload = JSON.parse(verifyRes.body)
    expect(payload.status).toBe('verified')
    expect(payload.checks).toMatchObject({
      dnsOk: true,
      cnameOk: false,
      tlsOk: true,
      connectOk: true,
      authOk: true,
      bidOk: true,
      landingUrlOk: true,
    })
  })

  it('binds domain as pending when runtime probe is network blocked', async () => {
    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['31.13.85.34']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue([]),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn().mockRejectedValue(new Error('socket hang up')),
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_pending',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'simple-chatbot-phi.vercel.app',
      placementId: 'chat_from_answer_v1',
    }

    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)

    expect(verifyRes.statusCode).toBe(200)
    expect(JSON.parse(verifyRes.body)).toMatchObject({
      status: 'pending',
      bindStage: 'probe_failed',
      failureCode: 'EGRESS_BLOCKED',
      legacyCode: 'NETWORK_BLOCKED',
      checks: {
        dnsOk: true,
        tlsOk: true,
        connectOk: true,
        authOk: false,
        bidOk: false,
        landingUrlOk: false,
      },
    })
  })

  it('returns managed runtime base from bootstrap when binding is pending and fallback is enabled', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com/api'
    process.env.MEDIATION_MANAGED_RUNTIME_BASE_URL = 'https://runtime-managed.example.com'

    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['31.13.85.34']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue([]),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn().mockRejectedValue(new Error('socket hang up')),
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_pending_bootstrap',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'simple-chatbot-phi.vercel.app',
      placementId: 'chat_from_answer_v1',
    }

    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)
    expect(JSON.parse(verifyRes.body)).toMatchObject({
      status: 'pending',
      failureCode: 'EGRESS_BLOCKED',
    })

    const bootstrapReq = createMockReq('/api/v1/public/sdk/bootstrap', 'GET', {
      authorization: 'Bearer sk_runtime_pending_bootstrap',
    })
    const bootstrapRes = createMockRes()
    await dashboardApiProxyHandler(bootstrapReq, bootstrapRes)

    expect(bootstrapRes.statusCode).toBe(200)
    expect(JSON.parse(bootstrapRes.body)).toMatchObject({
      runtimeSource: 'managed_fallback',
      runtimeBaseUrl: 'https://runtime-managed.example.com',
      customerRuntimeBaseUrl: 'https://simple-chatbot-phi.vercel.app',
      bindStatus: 'pending',
    })
  })

  it('supports runtime-domain probe and classifies server fail + browser pass as egress blocked', async () => {
    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['203.0.113.11']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue(['runtime-gateway.tappy.ai']),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn().mockResolvedValue(createJsonUpstreamResponse({
        requestId: 'req_seed',
        landingUrl: 'https://ads.customer.example/seed',
      })),
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_probe_1',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'runtime.customer-probe.org',
      placementId: 'chat_from_answer_v1',
    }
    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)
    expect(JSON.parse(verifyRes.body).status).toBe('verified')

    setRuntimeDepsForTests({
      fetch: vi.fn().mockRejectedValue(new Error('network blocked')),
    })

    const probeReq = createMockReq('/api/v1/public/runtime-domain/probe', 'POST', {
      authorization: 'Bearer sk_runtime_probe_1',
      'content-type': 'application/json',
    })
    probeReq.body = {
      runBrowserProbe: true,
      browserProbe: {
        ok: true,
        code: 'VERIFIED',
        httpStatus: 200,
        landingUrl: 'https://ads.customer.example/browser',
      },
    }
    const probeRes = createMockRes()
    await dashboardApiProxyHandler(probeReq, probeRes)

    expect(probeRes.statusCode).toBe(200)
    const payload = JSON.parse(probeRes.body)
    expect(payload).toMatchObject({
      finalStatus: 'pending',
      failureCode: 'EGRESS_BLOCKED',
      legacyCode: 'NETWORK_BLOCKED',
      serverProbe: {
        source: 'server',
        ok: false,
        code: 'EGRESS_BLOCKED',
      },
      browserProbe: {
        source: 'browser',
        ok: true,
      },
    })
  })

  it('upgrades pending binding to verified when runtime-domain probe succeeds', async () => {
    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['203.0.113.11']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue([]),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn().mockRejectedValue(new Error('network blocked')),
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_probe_2',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'runtime.customer-upgrade.org',
    }
    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)
    expect(JSON.parse(verifyRes.body).status).toBe('pending')

    setRuntimeDepsForTests({
      fetch: vi.fn().mockResolvedValue(createJsonUpstreamResponse({
        requestId: 'req_probe_ok',
        link: 'https://ads.customer.example/upgraded',
      })),
    })

    const probeReq = createMockReq('/api/v1/public/runtime-domain/probe', 'POST', {
      authorization: 'Bearer sk_runtime_probe_2',
      'content-type': 'application/json',
    })
    probeReq.body = {}
    const probeRes = createMockRes()
    await dashboardApiProxyHandler(probeReq, probeRes)
    expect(JSON.parse(probeRes.body)).toMatchObject({
      finalStatus: 'verified',
      status: 'verified',
    })

    const bootstrapReq = createMockReq('/api/v1/public/sdk/bootstrap', 'GET', {
      authorization: 'Bearer sk_runtime_probe_2',
    })
    const bootstrapRes = createMockRes()
    await dashboardApiProxyHandler(bootstrapReq, bootstrapRes)
    expect(JSON.parse(bootstrapRes.body)).toMatchObject({
      bindStatus: 'verified',
    })
  })

  it('enforces gateway cname when strict mode is enabled', async () => {
    process.env.MEDIATION_RUNTIME_REQUIRE_GATEWAY_CNAME = '1'
    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['31.13.85.34']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue(['cname.vercel-dns.com']),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn().mockResolvedValue(createJsonUpstreamResponse({ ok: true })),
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_strict',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'simple-chatbot-phi.vercel.app',
    }

    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)

    expect(JSON.parse(verifyRes.body)).toMatchObject({
      status: 'failed',
      failureCode: 'CNAME_MISMATCH',
    })
  })

  it('returns structured failure when runtime domain DNS is not resolvable', async () => {
    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue([]),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn(),
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_2',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'not-resolvable.customer-example.org',
    }

    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)

    expect(verifyRes.statusCode).toBe(200)
    expect(JSON.parse(verifyRes.body)).toMatchObject({
      status: 'failed',
      failureCode: 'DNS_ENOTFOUND',
    })
  })

  it('normalizes runtime bid response to include landingUrl', async () => {
    const fetchMock = vi.fn(async (url) => {
      const normalized = String(url)
      if (normalized.endsWith('/api/v2/bid')) {
        return createJsonUpstreamResponse({
          requestId: 'req_runtime_1',
          ad: {
            title: 'Great deal',
            url: 'https://ads.customer.example/deal',
          },
        })
      }
      throw new Error(`Unexpected runtime URL: ${normalized}`)
    })

    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['203.0.113.12']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue(['runtime-gateway.tappy.ai']),
      tlsConnect: createTlsConnectStub(),
      fetch: fetchMock,
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_3',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'runtime.customer-3.org',
    }
    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)
    expect(JSON.parse(verifyRes.body).status).toBe('verified')

    const bidReq = createMockReq('/api/v2/bid', 'POST', {
      authorization: 'Bearer sk_runtime_3',
      'content-type': 'application/json',
    })
    bidReq.body = { placementId: 'chat_from_answer_v1', messages: [] }

    const bidRes = createMockRes()
    await dashboardApiProxyHandler(bidReq, bidRes)

    expect(bidRes.statusCode).toBe(200)
    const payload = JSON.parse(bidRes.body)
    expect(payload.landingUrl).toBe('https://ads.customer.example/deal')
    expect(payload.ad.landingUrl).toBe('https://ads.customer.example/deal')
  })

  it('routes /api/v2/bid to managed fallback endpoint when bound domain is pending with endpoint mismatch', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com/api'
    process.env.MEDIATION_MANAGED_RUNTIME_BASE_URL = 'https://runtime-managed.example.com'

    const fetchMock = vi.fn(async (url) => {
      const normalized = String(url)
      if (normalized === 'https://simple-chatbot-phi.vercel.app/api/v2/bid') {
        return createJsonUpstreamResponse({
          error: {
            code: 'NOT_FOUND',
          },
        }, 404)
      }
      if (normalized === 'https://runtime-managed.example.com/api/v2/bid') {
        return createJsonUpstreamResponse({
          requestId: 'req_managed_1',
          landingUrl: 'https://ads.customer.example/managed',
        })
      }
      throw new Error(`Unexpected runtime URL: ${normalized}`)
    })

    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['31.13.85.34']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue([]),
      tlsConnect: createTlsConnectStub(),
      fetch: fetchMock,
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_pending_bid',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'simple-chatbot-phi.vercel.app',
      placementId: 'chat_from_answer_v1',
    }

    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)
    expect(JSON.parse(verifyRes.body)).toMatchObject({
      status: 'pending',
      failureCode: 'ENDPOINT_404',
    })

    const bidReq = createMockReq('/api/v2/bid', 'POST', {
      authorization: 'Bearer sk_runtime_pending_bid',
      'content-type': 'application/json',
    })
    bidReq.body = { placementId: 'chat_from_answer_v1', messages: [] }

    const bidRes = createMockRes()
    await dashboardApiProxyHandler(bidReq, bidRes)

    expect(bidRes.statusCode).toBe(200)
    expect(JSON.parse(bidRes.body)).toMatchObject({
      requestId: 'req_managed_1',
      landingUrl: 'https://ads.customer.example/managed',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://runtime-managed.example.com/api/v2/bid',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('serves managed_default bootstrap for unbound API key when managed runtime is configured', async () => {
    process.env.MEDIATION_MANAGED_RUNTIME_BASE_URL = 'https://runtime-managed.example.com'
    delete process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET

    const bootstrapReq = createMockReq('/api/v1/public/sdk/bootstrap', 'GET', {
      authorization: 'Bearer sk_runtime_unbound_bootstrap',
    })
    const bootstrapRes = createMockRes()
    await dashboardApiProxyHandler(bootstrapReq, bootstrapRes)

    expect(bootstrapRes.statusCode).toBe(200)
    expect(JSON.parse(bootstrapRes.body)).toMatchObject({
      runtimeSource: 'managed_default',
      runtimeBaseUrl: 'https://runtime-managed.example.com',
      bindStatus: 'unbound',
    })
  })

  it('returns structured route error for unbound API key when managed runtime is unavailable', async () => {
    delete process.env.MEDIATION_MANAGED_RUNTIME_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET

    const bootstrapReq = createMockReq('/api/v1/public/sdk/bootstrap', 'GET', {
      authorization: 'Bearer sk_runtime_unbound_fail',
    })
    const bootstrapRes = createMockRes()
    await dashboardApiProxyHandler(bootstrapReq, bootstrapRes)

    expect(bootstrapRes.statusCode).toBe(503)
    expect(JSON.parse(bootstrapRes.body)).toMatchObject({
      error: {
        code: 'MANAGED_RUNTIME_NOT_CONFIGURED',
        details: {
          bindStatus: 'unbound',
        },
      },
    })
  })

  it('routes /api/v2/bid to managed runtime by default for unbound API key', async () => {
    process.env.MEDIATION_MANAGED_RUNTIME_BASE_URL = 'https://runtime-managed.example.com'
    delete process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET

    const runtimeFetch = vi.fn().mockResolvedValue(createJsonUpstreamResponse({
      requestId: 'req_managed_default_bid',
      landingUrl: 'https://ads.customer.example/managed-default',
    }))
    setRuntimeDepsForTests({
      fetch: runtimeFetch,
    })

    const bidReq = createMockReq('/api/v2/bid', 'POST', {
      authorization: 'Bearer sk_runtime_unbound_bid',
      'content-type': 'application/json',
    })
    bidReq.body = {
      placementId: 'chat_from_answer_v1',
      messages: [],
    }

    const bidRes = createMockRes()
    await dashboardApiProxyHandler(bidReq, bidRes)

    expect(bidRes.statusCode).toBe(200)
    expect(bidRes.headers['x-tappy-runtime-source']).toBe('managed_default')
    expect(JSON.parse(bidRes.body)).toMatchObject({
      requestId: 'req_managed_default_bid',
      landingUrl: 'https://ads.customer.example/managed-default',
    })
    expect(runtimeFetch).toHaveBeenCalledWith(
      'https://runtime-managed.example.com/api/v2/bid',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('returns structured no-fill payload on /api/ad/bid when runtime route is unavailable', async () => {
    delete process.env.MEDIATION_MANAGED_RUNTIME_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL
    delete process.env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET

    const req = createMockReq('/api/ad/bid', 'POST', {
      authorization: 'Bearer sk_runtime_ad_bid',
      'content-type': 'application/json',
    })
    req.body = { messages: [] }

    const res = createMockRes()
    await dashboardApiProxyHandler(req, res)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      filled: false,
      reasonCode: 'MANAGED_RUNTIME_NOT_CONFIGURED',
      runtimeSource: 'none',
    })
  })

  it('restores runtime binding from control plane binding store after local cache reset', async () => {
    process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL = 'https://prod.example.com/api'
    let storedBinding = null

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options = {}) => {
      const normalizedUrl = String(url)
      const method = String(options?.method || 'GET').toUpperCase()
      if (normalizedUrl !== 'https://prod.example.com/api/v1/public/runtime-domain/binding') {
        throw new Error(`Unexpected binding store URL: ${normalizedUrl}`)
      }
      if (method === 'PUT') {
        storedBinding = JSON.parse(String(options.body || '{}')).binding
        return createJsonUpstreamResponse({ binding: storedBinding })
      }
      if (method === 'GET') {
        if (!storedBinding) return createJsonUpstreamResponse({}, 404)
        return createJsonUpstreamResponse({ binding: storedBinding })
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    setRuntimeDepsForTests({
      resolve4: vi.fn().mockResolvedValue(['203.0.113.11']),
      resolve6: vi.fn().mockResolvedValue([]),
      resolveCname: vi.fn().mockResolvedValue(['runtime-gateway.tappy.ai']),
      tlsConnect: createTlsConnectStub(),
      fetch: vi.fn().mockResolvedValue(createJsonUpstreamResponse({
        requestId: 'req_bind_store_ok',
        landingUrl: 'https://ads.customer.example/restored',
      })),
      now: () => 1735689600000,
    })

    const verifyReq = createMockReq('/api/v1/public/runtime-domain/verify-and-bind', 'POST', {
      authorization: 'Bearer sk_runtime_restore',
      'content-type': 'application/json',
    })
    verifyReq.body = {
      domain: 'runtime.customer-restore.org',
      placementId: 'chat_from_answer_v1',
    }
    const verifyRes = createMockRes()
    await dashboardApiProxyHandler(verifyReq, verifyRes)
    expect(JSON.parse(verifyRes.body).status).toBe('verified')

    clearRuntimeDomainBindingsForTests()

    const bootstrapReq = createMockReq('/api/v1/public/sdk/bootstrap', 'GET', {
      authorization: 'Bearer sk_runtime_restore',
    })
    const bootstrapRes = createMockRes()
    await dashboardApiProxyHandler(bootstrapReq, bootstrapRes)

    expect(bootstrapRes.statusCode).toBe(200)
    expect(JSON.parse(bootstrapRes.body)).toMatchObject({
      runtimeSource: 'customer',
      runtimeBaseUrl: 'https://runtime.customer-restore.org',
      bindStatus: 'verified',
    })
  })
})
