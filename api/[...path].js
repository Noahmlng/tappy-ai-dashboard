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
const DEFAULT_PLACEMENT_ID = 'chat_from_answer_v1'
const DEFAULT_KEY_NAME = 'runtime-prod'

export function normalizeUpstreamBaseUrl(rawValue) {
  const value = String(rawValue || '')
    .replace(/\\[nr]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
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

  if (isRegister) {
    if (!readAccountId(nextPayload)) {
      const email = cleanText(nextPayload.email).split('@')[0] || ''
      nextPayload.accountId = makeGeneratedAccountId(email)
      mutated = true
    }
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
    if (!cleanText(nextPayload.placementId)) {
      nextPayload.placementId = DEFAULT_PLACEMENT_ID
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
    if (HOP_BY_HOP_HEADERS.has(normalizedKey)) continue
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

export default async function dashboardApiProxyHandler(req, res) {
  const upstreamBaseUrl = resolveUpstreamBaseUrl()
  if (!upstreamBaseUrl) {
    sendJson(res, 500, {
      error: {
        code: 'PROXY_TARGET_NOT_CONFIGURED',
        message: 'Set MEDIATION_CONTROL_PLANE_API_BASE_URL (or MEDIATION_CONTROL_PLANE_API_PROXY_TARGET) to your control-plane API origin.',
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
