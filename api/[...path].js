const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

const RESPONSE_HEADERS_TO_STRIP = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
])

const BROWSER_ONLY_REQUEST_HEADERS = new Set([
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'access-control-request-method',
  'access-control-request-headers',
])

const UPSTREAM_TIMEOUT_MS = 10_000
const DEFAULT_ENVIRONMENT = 'prod'
const DEFAULT_KEY_NAME = 'runtime-prod'
const URL_IN_TEXT_RE = /(https?:\/\/[^\s"'<>]+)/i

const REMOVED_RUNTIME_ROUTES = Object.freeze({
  '/api/v1/public/sdk/bootstrap': {
    method: 'GET',
    code: 'BOOTSTRAP_REMOVED',
    message: 'Bootstrap has been removed. Use runtime key and POST /api/v2/bid directly.',
  },
  '/api/v1/public/runtime-domain/verify-and-bind': {
    method: 'POST',
    code: 'RUNTIME_BIND_FLOW_REMOVED',
    message: 'Runtime bind flow has been removed. Use runtime key and POST /api/v2/bid directly.',
  },
  '/api/v1/public/runtime-domain/probe': {
    method: 'POST',
    code: 'RUNTIME_BIND_FLOW_REMOVED',
    message: 'Runtime bind flow has been removed. Use runtime key and POST /api/v2/bid directly.',
  },
  '/api/ad/bid': {
    method: 'POST',
    code: 'AD_BID_ROUTE_REMOVED',
    message: 'Legacy /api/ad/bid has been removed. Use POST /api/v2/bid directly.',
  },
})

let runtimeDepsOverride = null

function defaultRuntimeDeps() {
  return {
    fetch: globalThis.fetch.bind(globalThis),
  }
}

function getRuntimeDeps() {
  return runtimeDepsOverride
    ? {
      ...defaultRuntimeDeps(),
      ...runtimeDepsOverride,
    }
    : defaultRuntimeDeps()
}

export function setRuntimeDepsForTests(overrides = null) {
  runtimeDepsOverride = overrides
}

export function clearRuntimeDomainBindingsForTests() {
  // No-op: runtime binding flow has been removed from dashboard proxy.
}

function cleanText(value) {
  return String(value || '').trim()
}

function pickFirstText(...values) {
  for (const value of values) {
    const normalized = cleanText(value)
    if (normalized) return normalized
  }
  return ''
}

function normalizeHost(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
}

function isPrivateIpv4(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false
  const parts = value.split('.').map((part) => Number(part))
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 127) return true
  if (parts[0] === 0) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  return false
}

function isPrivateIpv6(value) {
  const normalized = normalizeHost(value)
  if (!normalized.includes(':')) return false
  if (normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('fe80')) return true
  return false
}

function isPrivateOrLoopbackHost(hostname) {
  const normalized = normalizeHost(hostname)
  if (!normalized) return true
  if (normalized === 'localhost') return true
  if (isPrivateIpv4(normalized)) return true
  if (isPrivateIpv6(normalized)) return true
  return false
}

function isReservedDomain(hostname) {
  const normalized = normalizeHost(hostname)
  return normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.localhost')
}

export function normalizeRuntimeDomain(rawValue) {
  const original = cleanText(rawValue)
  if (!original) {
    return { ok: false, failureCode: 'RUNTIME_DOMAIN_REQUIRED', message: 'Runtime domain is required.' }
  }
  let parsed
  try {
    parsed = new URL(original.startsWith('http') ? original : `https://${original}`)
  } catch {
    return { ok: false, failureCode: 'RUNTIME_DOMAIN_INVALID', message: 'Runtime domain is invalid.' }
  }
  if (!['https:'].includes(parsed.protocol)) {
    return { ok: false, failureCode: 'RUNTIME_DOMAIN_INVALID', message: 'Runtime domain must use HTTPS.' }
  }
  const hostname = normalizeHost(parsed.hostname)
  if (!hostname || isPrivateOrLoopbackHost(hostname) || isReservedDomain(hostname)) {
    return { ok: false, failureCode: 'RUNTIME_DOMAIN_INVALID', message: 'Runtime domain is not allowed.' }
  }

  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return {
    ok: true,
    hostname,
    runtimeBaseUrl: parsed.toString().replace(/\/$/, ''),
  }
}

function extractFirstUrl(value) {
  const input = cleanText(value)
  if (!input) return ''
  const match = input.match(URL_IN_TEXT_RE)
  return cleanText(match?.[1] || input)
}

function pickLandingUrl(source = {}) {
  return pickFirstText(
    source.landingUrl,
    source.url,
    source.link,
    source.redirectUrl,
    source.targetUrl,
    source.clickUrl,
    source.destinationUrl,
    source?.bid?.landingUrl,
    source?.bid?.url,
    source?.bid?.link,
    source?.data?.landingUrl,
    source?.data?.url,
    source?.data?.link,
    extractFirstUrl(source.reasonMessage),
    extractFirstUrl(source.message),
  )
}

export function normalizeBidPayload(source = {}) {
  const payload = source && typeof source === 'object' ? { ...source } : {}
  const landingUrl = pickLandingUrl(payload)
  if (landingUrl) {
    payload.landingUrl = landingUrl
  }
  if (!cleanText(payload.requestId)) {
    payload.requestId = pickFirstText(payload.traceId, payload?.bid?.requestId)
  }
  return {
    payload,
    landingUrl: cleanText(payload.landingUrl),
  }
}

export function normalizeUpstreamBaseUrl(rawValue) {
  let value = String(rawValue || '')
    .replace(/\\[nr]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  if (!value) return ''

  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''

    const pathname = parsed.pathname.replace(/\/$/, '')
    if (!pathname || pathname === '/') {
      parsed.pathname = '/api'
    } else if (!pathname.endsWith('/api')) {
      parsed.pathname = `${pathname}/api`
    } else {
      parsed.pathname = pathname
    }
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

export function resolveUpstreamBaseUrl(env = process.env) {
  const candidates = [
    env.MEDIATION_CONTROL_PLANE_API_BASE_URL,
    env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeUpstreamBaseUrl(candidate)
    if (normalized) return normalized
  }
  return ''
}

export function resolveRuntimeApiBaseUrl(env = process.env) {
  const explicitRuntimeUrl = normalizeUpstreamBaseUrl(env.MEDIATION_RUNTIME_API_BASE_URL)
  if (explicitRuntimeUrl) return explicitRuntimeUrl
  return resolveUpstreamBaseUrl(env)
}

function normalizePublicBaseUrl(rawValue) {
  const input = cleanText(rawValue)
  if (!input) return ''
  try {
    const parsed = new URL(input)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

export function resolveManagedRuntimeBaseUrl(env = process.env) {
  const explicit = normalizePublicBaseUrl(env.MEDIATION_MANAGED_RUNTIME_BASE_URL)
  const fallback = explicit || normalizeUpstreamBaseUrl(
    env.MEDIATION_CONTROL_PLANE_API_BASE_URL || env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET,
  )
  if (!fallback) return ''
  try {
    const parsed = new URL(fallback)
    const pathname = parsed.pathname.replace(/\/$/, '')
    parsed.pathname = pathname.endsWith('/api')
      ? (pathname.slice(0, -4) || '/')
      : (pathname || '/')
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

export function buildUpstreamUrl(req, upstreamBaseUrl) {
  const requestUrl = new URL(req.url || '/api', 'http://localhost')
  const base = new URL(upstreamBaseUrl)
  const basePath = base.pathname.replace(/\/$/, '')

  const incomingPath = requestUrl.pathname.startsWith('/api')
    ? requestUrl.pathname.slice('/api'.length)
    : requestUrl.pathname
  const suffix = incomingPath
    ? (incomingPath.startsWith('/') ? incomingPath : `/${incomingPath}`)
    : ''

  base.pathname = `${basePath}${suffix}`
  base.search = requestUrl.search
  return base.toString()
}

export function buildUpstreamHeaders(req) {
  const headers = {}
  const requestOrigin = String(req?.headers?.origin || '').trim()

  for (const [key, value] of Object.entries(req.headers || {})) {
    if (value === undefined || value === null) continue
    const normalizedKey = String(key || '').toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(normalizedKey)) continue
    if (BROWSER_ONLY_REQUEST_HEADERS.has(normalizedKey)) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }

  if (requestOrigin) {
    headers['x-forwarded-origin'] = requestOrigin
  }

  return headers
}

function readAccountId(source = {}) {
  return pickFirstText(
    source.accountId,
    source.account_id,
    source.organizationId,
    source.organization_id,
  )
}

function readAppId(source = {}) {
  return pickFirstText(
    source.appId,
    source.app_id,
  )
}

function decodeRequestBodyToText(body) {
  if (body === undefined || body === null) return ''
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  if (typeof body === 'string') return body
  return String(body)
}

function parseJsonBody(body) {
  const raw = decodeRequestBodyToText(body).trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function stripLegacyScopeAliases(payload = {}) {
  const next = { ...payload }
  Reflect.deleteProperty(next, 'account_id')
  Reflect.deleteProperty(next, 'organizationId')
  Reflect.deleteProperty(next, 'organization_id')
  Reflect.deleteProperty(next, 'app_id')
  return next
}

function ensureJsonContentType(headers = {}) {
  const nextHeaders = { ...headers }
  const hasContentType = Object.keys(nextHeaders).some((key) => key.toLowerCase() === 'content-type')
  if (!hasContentType) {
    nextHeaders['content-type'] = 'application/json; charset=utf-8'
  }
  return nextHeaders
}

function makeGeneratedAccountId(seedText = '') {
  const normalizedSeed = cleanText(seedText)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
  const suffix = Date.now().toString(36).slice(-6)
  return `org_${normalizedSeed || 'user'}_${suffix}`
}

function buildMeUrl(upstreamBaseUrl) {
  const base = new URL(upstreamBaseUrl)
  const path = base.pathname.replace(/\/$/, '')
  base.pathname = `${path}/v1/public/dashboard/me`
  base.search = ''
  return base.toString()
}

async function fetchSessionScope(upstreamBaseUrl, headers, signal) {
  try {
    const response = await fetch(buildMeUrl(upstreamBaseUrl), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    })
    if (!response.ok) return {}

    const contentType = cleanText(response.headers.get('content-type')).toLowerCase()
    if (!contentType.includes('application/json')) return {}
    const payload = await response.json().catch(() => ({}))

    const scope = payload?.scope && typeof payload.scope === 'object' ? payload.scope : {}
    const user = payload?.user && typeof payload.user === 'object' ? payload.user : {}
    return {
      accountId: pickFirstText(readAccountId(scope), readAccountId(user)),
      appId: pickFirstText(readAppId(scope), readAppId(user)),
    }
  } catch {
    return {}
  }
}

function readReqPathname(req) {
  const requestUrl = new URL(req.url || '/api', 'http://localhost')
  return requestUrl.pathname
}

async function maybeEnrichRequest(req, upstreamBaseUrl, headers, body, signal) {
  const method = cleanText(req.method || 'GET').toUpperCase()
  if (method !== 'POST') {
    return { headers, body }
  }

  const pathname = readReqPathname(req)
  const payload = parseJsonBody(body)
  if (payload === null) {
    return { headers, body }
  }

  let nextPayload = stripLegacyScopeAliases(payload)
  let mutated = false
  const isVerify = pathname === '/api/v1/public/quick-start/verify'
  const isCreateKey = pathname === '/api/v1/public/credentials/keys'
  const isRegister = pathname === '/api/v1/public/dashboard/register'

  if (!isVerify && !isCreateKey && !isRegister) {
    return { headers, body }
  }

  let sessionScope = null
  const ensureSessionScope = async () => {
    if (sessionScope) return sessionScope
    sessionScope = await fetchSessionScope(upstreamBaseUrl, headers, signal)
    return sessionScope
  }

  if (isRegister && !readAccountId(nextPayload)) {
    const email = cleanText(nextPayload.email).split('@')[0] || ''
    nextPayload.accountId = makeGeneratedAccountId(email)
    mutated = true
  }

  if (isCreateKey || isVerify) {
    let accountId = readAccountId(nextPayload)
    let appId = readAppId(nextPayload)

    if (!accountId || !appId) {
      const scope = await ensureSessionScope()
      accountId = accountId || cleanText(scope.accountId)
      appId = appId || cleanText(scope.appId)
    }

    if (accountId && cleanText(nextPayload.accountId) !== accountId) {
      nextPayload.accountId = accountId
      mutated = true
    }
    if (appId && cleanText(nextPayload.appId) !== appId) {
      nextPayload.appId = appId
      mutated = true
    }
  }

  if (isCreateKey) {
    if (!cleanText(nextPayload.environment)) {
      nextPayload.environment = DEFAULT_ENVIRONMENT
      mutated = true
    }
    if (!cleanText(nextPayload.name)) {
      nextPayload.name = DEFAULT_KEY_NAME
      mutated = true
    }
  }

  if (isVerify) {
    if (!cleanText(nextPayload.environment)) {
      nextPayload.environment = DEFAULT_ENVIRONMENT
      mutated = true
    }
  }

  if (!mutated) {
    return { headers, body }
  }

  return {
    headers: ensureJsonContentType(headers),
    body: JSON.stringify(nextPayload),
  }
}

export async function readRequestBody(req) {
  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return undefined

  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body
    if (typeof req.body === 'string') return req.body
    if (typeof req.body === 'object') return JSON.stringify(req.body)
  }

  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return undefined
  return Buffer.concat(chunks)
}

function setUpstreamResponseHeaders(res, upstreamResponse) {
  let cookies = []
  const getSetCookie = upstreamResponse.headers?.getSetCookie
  if (typeof getSetCookie === 'function') {
    cookies = getSetCookie.call(upstreamResponse.headers)
  } else {
    const rawSetCookie = upstreamResponse.headers.get('set-cookie')
    cookies = parseSetCookieHeader(rawSetCookie)
  }

  if (Array.isArray(cookies) && cookies.length > 0) {
    res.setHeader('set-cookie', cookies)
  }

  for (const [key, value] of upstreamResponse.headers.entries()) {
    const normalizedKey = String(key || '').toLowerCase()
    if (normalizedKey === 'set-cookie') continue
    if (RESPONSE_HEADERS_TO_STRIP.has(normalizedKey)) continue
    res.setHeader(key, value)
  }
}

function parseSetCookieHeader(value) {
  const input = String(value || '').trim()
  if (!input) return []

  const cookies = []
  let start = 0
  let inExpires = false

  for (let i = 0; i < input.length; i += 1) {
    const nextEight = input.slice(i, i + 8).toLowerCase()
    if (nextEight === 'expires=') {
      inExpires = true
      i += 7
      continue
    }

    const char = input[i]
    if (inExpires && char === ';') {
      inExpires = false
      continue
    }

    if (!inExpires && char === ',') {
      const chunk = input.slice(start, i).trim()
      if (chunk) cookies.push(chunk)
      start = i + 1
    }
  }

  const tail = input.slice(start).trim()
  if (tail) cookies.push(tail)
  return cookies
}

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function readHeaderValue(headers = {}, key) {
  if (!headers || typeof headers !== 'object') return ''
  const direct = headers[key]
  if (Array.isArray(direct)) {
    return cleanText(direct[0])
  }
  if (direct !== undefined) return cleanText(direct)
  const lower = headers[String(key || '').toLowerCase()]
  if (Array.isArray(lower)) return cleanText(lower[0])
  return cleanText(lower)
}

function normalizeAuthorization(rawValue) {
  return cleanText(rawValue)
}

function stripResponseHopByHopHeaders(responseHeaders = {}) {
  const output = {}
  for (const [key, value] of Object.entries(responseHeaders || {})) {
    const normalizedKey = String(key || '').toLowerCase()
    if (RESPONSE_HEADERS_TO_STRIP.has(normalizedKey)) continue
    output[key] = value
  }
  return output
}

async function requestRuntimeBid(input = {}) {
  const deps = input.deps || getRuntimeDeps()
  const targetUrl = cleanText(input.targetUrl)
  const requestBody = input.requestBody
  const headers = input.headers || {}

  try {
    const upstreamResponse = await deps.fetch(targetUrl, {
      method: 'POST',
      headers,
      body: requestBody,
    })

    const contentType = cleanText(upstreamResponse.headers.get('content-type')).toLowerCase()
    const status = Number(upstreamResponse.status || 500)
    const responseHeaders = stripResponseHopByHopHeaders(
      Object.fromEntries(upstreamResponse.headers.entries()),
    )

    if (!contentType.includes('application/json')) {
      return {
        ok: true,
        passthrough: true,
        status,
        contentType: contentType || 'application/octet-stream',
        responseHeaders,
        buffer: Buffer.from(await upstreamResponse.arrayBuffer()),
      }
    }

    const jsonPayload = await upstreamResponse.json().catch(() => null)
    if (!jsonPayload || typeof jsonPayload !== 'object') {
      return {
        ok: false,
        status: 502,
        errorCode: 'BID_INVALID_RESPONSE',
        errorMessage: 'Runtime bid response is not valid JSON.',
      }
    }

    if (jsonPayload.filled === false) {
      return {
        ok: false,
        status,
        errorCode: cleanText(jsonPayload.reasonCode || 'UPSTREAM_NO_FILL'),
        errorMessage: cleanText(jsonPayload.reasonMessage || 'Runtime bid response returned filled=false.'),
      }
    }

    const { payload: normalizedPayload, landingUrl } = normalizeBidPayload(jsonPayload)
    if (!landingUrl) {
      return {
        ok: false,
        status: 502,
        errorCode: 'BID_INVALID_RESPONSE',
        errorMessage: 'Runtime bid response does not include landingUrl.',
      }
    }

    return {
      ok: true,
      passthrough: false,
      status,
      payload: normalizedPayload,
      responseHeaders,
    }
  } catch {
    return {
      ok: false,
      status: 502,
      errorCode: 'NETWORK_BLOCKED',
      errorMessage: 'Failed to reach runtime /api/v2/bid.',
    }
  }
}

async function handleRuntimeBidProxy(req, res) {
  const authorization = normalizeAuthorization(readHeaderValue(req.headers, 'authorization'))
  if (!authorization) {
    sendJson(res, 401, {
      error: {
        code: 'AUTH_FORBIDDEN',
        message: 'Authorization header is required.',
      },
    })
    return
  }

  const runtimeApiBaseUrl = resolveRuntimeApiBaseUrl()
  if (!runtimeApiBaseUrl) {
    sendJson(res, 500, {
      error: {
        code: 'PROXY_RUNTIME_TARGET_NOT_CONFIGURED',
        message: 'Set MEDIATION_CONTROL_PLANE_API_BASE_URL (or MEDIATION_CONTROL_PLANE_API_PROXY_TARGET). MEDIATION_RUNTIME_API_BASE_URL is optional as an override.',
      },
    })
    return
  }

  const deps = getRuntimeDeps()
  const requestBody = await readRequestBody(req)
  const headers = buildUpstreamHeaders(req)
  headers.authorization = authorization
  const targetUrl = `${runtimeApiBaseUrl}/v2/bid`
  const bidResult = await requestRuntimeBid({
    deps,
    targetUrl,
    requestBody,
    headers,
  })

  res.setHeader('x-tappy-runtime-source', 'runtime_api_base_url')
  if (!bidResult.ok) {
    sendJson(res, Number(bidResult.status || 502), {
      error: {
        code: cleanText(bidResult.errorCode || 'NETWORK_BLOCKED'),
        message: cleanText(bidResult.errorMessage || 'Failed to execute runtime bid request.'),
      },
    })
    return
  }

  if (bidResult.passthrough) {
    res.statusCode = Number(bidResult.status || 200)
    for (const [key, value] of Object.entries(bidResult.responseHeaders || {})) {
      res.setHeader(key, value)
    }
    res.setHeader('content-type', cleanText(bidResult.contentType) || 'application/octet-stream')
    res.end(bidResult.buffer)
    return
  }

  res.statusCode = Number(bidResult.status || 200)
  for (const [key, value] of Object.entries(bidResult.responseHeaders || {})) {
    res.setHeader(key, value)
  }
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(bidResult.payload))
}

export default async function dashboardApiProxyHandler(req, res) {
  const method = cleanText(req.method || 'GET').toUpperCase()
  const pathname = readReqPathname(req)

  if (Object.prototype.hasOwnProperty.call(REMOVED_RUNTIME_ROUTES, pathname)) {
    const policy = REMOVED_RUNTIME_ROUTES[pathname]
    if (method === String(policy?.method || '').toUpperCase()) {
      sendJson(res, 410, {
        error: {
          code: cleanText(policy.code),
          message: cleanText(policy.message),
        },
      })
      return
    }
  }

  if (pathname === '/api/v2/bid' && method === 'POST') {
    await handleRuntimeBidProxy(req, res)
    return
  }

  const upstreamBaseUrl = resolveUpstreamBaseUrl()
  if (!upstreamBaseUrl) {
    const configuredButInvalid = Boolean(
      cleanText(process.env.MEDIATION_CONTROL_PLANE_API_BASE_URL)
      || cleanText(process.env.MEDIATION_CONTROL_PLANE_API_PROXY_TARGET),
    )
    sendJson(res, 500, {
      error: {
        code: configuredButInvalid
          ? 'PROXY_TARGET_INVALID'
          : 'PROXY_TARGET_NOT_CONFIGURED',
        message: configuredButInvalid
          ? 'MEDIATION_CONTROL_PLANE_API_BASE_URL (or MEDIATION_CONTROL_PLANE_API_PROXY_TARGET) is set but invalid. Use a full http/https origin, optionally with /api.'
          : 'Set MEDIATION_CONTROL_PLANE_API_BASE_URL (or MEDIATION_CONTROL_PLANE_API_PROXY_TARGET) to your control-plane API origin.',
      },
    })
    return
  }

  const targetUrl = buildUpstreamUrl(req, upstreamBaseUrl)
  const upstreamHeaders = buildUpstreamHeaders(req)
  const requestBody = await readRequestBody(req)

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort('Upstream timeout')
  }, UPSTREAM_TIMEOUT_MS)

  try {
    const enrichedRequest = await maybeEnrichRequest(
      req,
      upstreamBaseUrl,
      upstreamHeaders,
      requestBody,
      controller.signal,
    )

    const upstreamResponse = await fetch(targetUrl, {
      method: String(req.method || 'GET').toUpperCase(),
      headers: enrichedRequest.headers,
      body: enrichedRequest.body,
      redirect: 'manual',
      signal: controller.signal,
    })

    res.statusCode = upstreamResponse.status
    setUpstreamResponseHeaders(res, upstreamResponse)

    const buffer = Buffer.from(await upstreamResponse.arrayBuffer())
    res.end(buffer)
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError'
    sendJson(res, 502, {
      error: {
        code: isTimeout ? 'PROXY_UPSTREAM_TIMEOUT' : 'PROXY_UPSTREAM_FETCH_FAILED',
        message: isTimeout
          ? 'Upstream API request timed out.'
          : 'Failed to reach upstream API.',
      },
    })
  } finally {
    clearTimeout(timer)
  }
}
