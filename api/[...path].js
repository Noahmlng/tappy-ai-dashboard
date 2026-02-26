import { createHash } from 'node:crypto'
import { resolve4 as dnsResolve4, resolve6 as dnsResolve6, resolveCname as dnsResolveCname } from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'

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
const DEFAULT_RUNTIME_GATEWAY_HOST = 'runtime-gateway.tappy.ai'
const RUNTIME_VERIFY_TIMEOUT_MS = 8_000
const URL_IN_TEXT_RE = /(https?:\/\/[^\s"'<>]+)/i

const runtimeDomainBindings = new Map()
let runtimeDepsOverride = null

function defaultRuntimeDeps() {
  return {
    resolve4: dnsResolve4,
    resolve6: dnsResolve6,
    resolveCname: dnsResolveCname,
    tlsConnect: tls.connect.bind(tls),
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    random: () => Math.random(),
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
  runtimeDomainBindings.clear()
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
}

function isPrivateIpv4(value) {
  const parts = String(value || '')
    .split('.')
    .map((item) => Number.parseInt(item, 10))
  if (parts.length !== 4 || parts.some((item) => Number.isNaN(item))) return false

  if (parts[0] === 10) return true
  if (parts[0] === 127) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  return false
}

function isPrivateIpv6(value) {
  const normalized = String(value || '').toLowerCase()
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:')
}

function isPrivateOrLoopbackHost(hostname) {
  const normalized = normalizeHost(hostname)
  const ipVersion = net.isIP(normalized)
  if (ipVersion === 4) return isPrivateIpv4(normalized)
  if (ipVersion === 6) return isPrivateIpv6(normalized)
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
}

function isReservedDomain(hostname) {
  const normalized = normalizeHost(hostname)
  if (!normalized) return true
  if (normalized === 'example.com') return true
  if (normalized.endsWith('.example.com')) return true
  return false
}

export function normalizeRuntimeDomain(rawValue) {
  const input = cleanText(rawValue)
  if (!input) return { ok: false, failureCode: 'CNAME_MISMATCH' }

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `https://${input}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, failureCode: 'CNAME_MISMATCH' }
  }

  const protocol = String(parsed.protocol || '').toLowerCase()
  const hostname = normalizeHost(parsed.hostname)
  if (!['http:', 'https:'].includes(protocol) || !hostname) {
    return { ok: false, failureCode: 'CNAME_MISMATCH' }
  }
  if (isReservedDomain(hostname) || isPrivateOrLoopbackHost(hostname)) {
    return { ok: false, failureCode: 'CNAME_MISMATCH' }
  }

  return {
    ok: true,
    hostname,
    runtimeBaseUrl: `https://${hostname}`,
  }
}

function createRequestId(prefix = 'req') {
  const random = Math.floor((1 + Math.random()) * 1_000_000).toString(36)
  return `${prefix}_${Date.now().toString(36)}_${random}`
}

function readHeaderValue(headers = {}, key) {
  const target = String(key || '').toLowerCase()
  for (const [headerKey, value] of Object.entries(headers || {})) {
    if (String(headerKey || '').toLowerCase() === target) {
      return Array.isArray(value) ? String(value[0] || '') : String(value || '')
    }
  }
  return ''
}

function normalizeAuthorization(rawValue) {
  return cleanText(rawValue)
}

function makeTenantId(authorization, deps) {
  const digest = createHash('sha256')
    .update(cleanText(authorization))
    .digest('hex')
    .slice(0, 12)
  const now = Number(deps?.now?.() || Date.now()).toString(36).slice(-4)
  return `tenant_${digest}_${now}`
}

function extractFirstUrl(value) {
  const input = cleanText(value)
  if (!input) return ''
  const matched = input.match(URL_IN_TEXT_RE)
  return matched ? cleanText(matched[1]) : ''
}

function pickLandingUrl(source = {}) {
  const payload = source && typeof source === 'object' ? source : {}
  const ad = payload.ad && typeof payload.ad === 'object' ? payload.ad : {}

  return pickFirstText(
    payload.landingUrl,
    payload.url,
    payload.link,
    ad.landingUrl,
    ad.url,
    ad.link,
    extractFirstUrl(payload.message),
    extractFirstUrl(ad.message),
  )
}

export function normalizeBidPayload(source = {}) {
  const payload = source && typeof source === 'object' ? source : {}
  const landingUrl = pickLandingUrl(payload)
  const ad = payload.ad && typeof payload.ad === 'object'
    ? {
      ...payload.ad,
      landingUrl: pickFirstText(
        payload.ad.landingUrl,
        payload.ad.url,
        payload.ad.link,
        landingUrl,
      ),
    }
    : payload.ad

  const next = {
    ...payload,
    ad,
  }
  if (landingUrl) {
    next.landingUrl = landingUrl
  }
  return {
    payload: next,
    landingUrl,
  }
}

function createChecks() {
  return {
    dnsOk: false,
    cnameOk: false,
    tlsOk: false,
    connectOk: false,
    authOk: false,
    bidOk: false,
    landingUrlOk: false,
  }
}

function createRuntimeError(failureCode, message = '') {
  const error = new Error(message || failureCode)
  error.failureCode = failureCode
  return error
}

async function resolveDnsWithCname(hostname, gatewayHost, deps, options = {}) {
  const normalizedHost = normalizeHost(hostname)
  const normalizedGatewayHost = normalizeHost(gatewayHost)
  const requireGatewayCname = options?.requireGatewayCname === true
  const checks = {
    dnsOk: false,
    cnameOk: false,
  }

  const [ipv4, ipv6] = await Promise.all([
    deps.resolve4(normalizedHost).catch(() => []),
    deps.resolve6(normalizedHost).catch(() => []),
  ])
  const hasAddress = (Array.isArray(ipv4) && ipv4.length > 0) || (Array.isArray(ipv6) && ipv6.length > 0)

  let cnameTargets = []
  try {
    cnameTargets = await deps.resolveCname(normalizedHost)
  } catch {
    cnameTargets = []
  }

  if (!hasAddress && cnameTargets.length === 0) {
    throw createRuntimeError('DNS_ENOTFOUND', 'Domain is not resolvable.')
  }
  checks.dnsOk = true

  const normalizedTargets = cnameTargets.map((item) => normalizeHost(item))
  if (normalizedTargets.includes(normalizedGatewayHost)) {
    checks.cnameOk = true
    return checks
  }

  if (requireGatewayCname) {
    throw createRuntimeError('CNAME_MISMATCH', 'Domain is not pointing to runtime gateway.')
  }
  checks.cnameOk = false
  return checks
}

async function verifyTls(hostname, deps) {
  const checks = {
    tlsOk: false,
    connectOk: false,
  }
  await new Promise((resolve, reject) => {
    const socket = deps.tlsConnect({
      host: hostname,
      port: 443,
      servername: hostname,
      rejectUnauthorized: true,
    })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(createRuntimeError('TLS_INVALID', 'TLS handshake timed out.'))
    }, RUNTIME_VERIFY_TIMEOUT_MS)

    socket.on('secureConnect', () => {
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      reject(createRuntimeError('TLS_INVALID', 'TLS handshake failed.'))
    })
  })
  checks.tlsOk = true
  checks.connectOk = true
  return checks
}

function createBidProbePayload(placementId) {
  return {
    userId: 'probe_user',
    chatId: 'probe_chat',
    placementId: cleanText(placementId) || DEFAULT_PLACEMENT_ID,
    messages: [
      { role: 'user', content: 'probe message' },
      { role: 'assistant', content: 'probe context' },
    ],
  }
}

async function readJsonResponse(response) {
  const contentType = cleanText(response?.headers?.get('content-type')).toLowerCase()
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null)
  }
  const rawText = await response.text().catch(() => '')
  if (!rawText) return null
  try {
    return JSON.parse(rawText)
  } catch {
    return null
  }
}

async function probeBid(runtimeBaseUrl, placementId, authorization, deps) {
  const probeResponse = await deps.fetch(`${runtimeBaseUrl}/api/v2/bid`, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(createBidProbePayload(placementId)),
  }).catch((error) => {
    if (error?.failureCode) throw error
    throw createRuntimeError('NETWORK_BLOCKED', 'Runtime bid probe failed.')
  })

  if (!probeResponse) {
    throw createRuntimeError('NETWORK_BLOCKED', 'Runtime bid probe failed.')
  }

  if (probeResponse.status === 401 || probeResponse.status === 403) {
    throw createRuntimeError('AUTH_FORBIDDEN', 'Authorization rejected by runtime.')
  }
  if (!probeResponse.ok) {
    throw createRuntimeError('NETWORK_BLOCKED', `Runtime bid probe failed with status ${probeResponse.status}.`)
  }

  const parsed = await readJsonResponse(probeResponse)
  if (!parsed || typeof parsed !== 'object') {
    throw createRuntimeError('BID_INVALID_RESPONSE', 'Runtime bid response is not JSON.')
  }

  const { landingUrl, payload } = normalizeBidPayload(parsed)
  if (!landingUrl) {
    throw createRuntimeError('BID_INVALID_RESPONSE', 'Runtime bid response does not contain landingUrl.')
  }

  return {
    landingUrl,
    payload,
  }
}

function getBoundRuntimeByAuthorization(authorization) {
  const normalized = normalizeAuthorization(authorization)
  if (!normalized) return null
  return runtimeDomainBindings.get(normalized) || null
}

function setBoundRuntimeByAuthorization(authorization, binding) {
  const normalized = normalizeAuthorization(authorization)
  if (!normalized) return
  runtimeDomainBindings.set(normalized, {
    ...binding,
  })
}

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

function getRuntimeGatewayHost(env = process.env) {
  const configured = cleanText(env?.MEDIATION_RUNTIME_GATEWAY_HOST)
  return normalizeHost(configured || DEFAULT_RUNTIME_GATEWAY_HOST)
}

function shouldRequireGatewayCname(env = process.env) {
  return cleanText(env?.MEDIATION_RUNTIME_REQUIRE_GATEWAY_CNAME) === '1'
}

async function handleRuntimeDomainVerifyAndBind(req, res) {
  const requestId = createRequestId('req_runtime_bind')
  const checks = createChecks()
  const deps = getRuntimeDeps()
  const requestBody = await readRequestBody(req)
  const payload = parseJsonBody(requestBody)
  const authorization = normalizeAuthorization(readHeaderValue(req.headers, 'authorization'))

  const placementId = cleanText(payload?.placementId) || DEFAULT_PLACEMENT_ID
  const normalizedDomain = normalizeRuntimeDomain(payload?.domain)
  const runtimeBaseUrl = normalizedDomain.runtimeBaseUrl || ''

  if (!authorization) {
    sendJson(res, 200, {
      status: 'failed',
      runtimeBaseUrl,
      checks,
      requestId,
      failureCode: 'AUTH_FORBIDDEN',
    })
    return
  }

  if (!normalizedDomain.ok) {
    sendJson(res, 200, {
      status: 'failed',
      runtimeBaseUrl,
      checks,
      requestId,
      failureCode: normalizedDomain.failureCode || 'CNAME_MISMATCH',
    })
    return
  }

  try {
    const dnsChecks = await resolveDnsWithCname(
      normalizedDomain.hostname,
      getRuntimeGatewayHost(),
      deps,
      {
        requireGatewayCname: shouldRequireGatewayCname(),
      },
    )
    checks.dnsOk = dnsChecks.dnsOk
    checks.cnameOk = dnsChecks.cnameOk

    const tlsChecks = await verifyTls(normalizedDomain.hostname, deps)
    checks.tlsOk = tlsChecks.tlsOk
    checks.connectOk = tlsChecks.connectOk

    const probe = await probeBid(runtimeBaseUrl, placementId, authorization, deps)
    checks.authOk = true
    checks.bidOk = true
    checks.landingUrlOk = Boolean(probe.landingUrl)

    const tenantId = makeTenantId(authorization, deps)
    setBoundRuntimeByAuthorization(authorization, {
      tenantId,
      runtimeBaseUrl,
      placementId,
      keyScope: 'tenant',
      verifiedAt: new Date().toISOString(),
    })

    sendJson(res, 200, {
      status: 'verified',
      runtimeBaseUrl,
      checks,
      requestId,
      landingUrlSample: probe.landingUrl,
      tenantId,
      keyScope: 'tenant',
      placementDefaults: {
        placementId,
      },
    })
  } catch (error) {
    const failureCode = cleanText(error?.failureCode) || 'NETWORK_BLOCKED'
    if (failureCode === 'AUTH_FORBIDDEN') {
      checks.authOk = false
    }
    sendJson(res, 200, {
      status: 'failed',
      runtimeBaseUrl,
      checks,
      requestId,
      failureCode,
    })
  }
}

function handleSdkBootstrap(req, res) {
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

  const binding = getBoundRuntimeByAuthorization(authorization)
  if (!binding) {
    sendJson(res, 404, {
      error: {
        code: 'RUNTIME_DOMAIN_NOT_BOUND',
        message: 'Runtime domain is not bound for this API key.',
      },
    })
    return
  }

  sendJson(res, 200, {
    runtimeBaseUrl: binding.runtimeBaseUrl,
    placementDefaults: {
      placementId: binding.placementId || DEFAULT_PLACEMENT_ID,
    },
    tenantId: binding.tenantId,
    keyScope: 'tenant',
  })
}

function stripResponseHopByHopHeaders(responseHeaders = {}) {
  const output = {}
  for (const [key, value] of Object.entries(responseHeaders || {})) {
    const normalizedKey = String(key || '').toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(normalizedKey)) continue
    output[key] = value
  }
  return output
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

  const binding = getBoundRuntimeByAuthorization(authorization)
  if (!binding?.runtimeBaseUrl) {
    sendJson(res, 404, {
      error: {
        code: 'RUNTIME_DOMAIN_NOT_BOUND',
        message: 'Runtime domain is not bound for this API key.',
      },
    })
    return
  }

  const deps = getRuntimeDeps()
  const requestBody = await readRequestBody(req)
  const headers = buildUpstreamHeaders(req)
  headers.authorization = authorization

  try {
    const upstreamResponse = await deps.fetch(`${binding.runtimeBaseUrl}/api/v2/bid`, {
      method: 'POST',
      headers,
      body: requestBody,
    })

    const contentType = cleanText(upstreamResponse.headers.get('content-type')).toLowerCase()
    const status = Number(upstreamResponse.status || 500)
    if (!contentType.includes('application/json')) {
      const passthroughBuffer = Buffer.from(await upstreamResponse.arrayBuffer())
      res.statusCode = status
      res.setHeader('content-type', contentType || 'application/octet-stream')
      res.end(passthroughBuffer)
      return
    }

    const jsonPayload = await upstreamResponse.json().catch(() => null)
    if (!jsonPayload || typeof jsonPayload !== 'object') {
      sendJson(res, 502, {
        error: {
          code: 'BID_INVALID_RESPONSE',
          message: 'Runtime bid response is not valid JSON.',
        },
      })
      return
    }

    const { payload: normalizedPayload, landingUrl } = normalizeBidPayload(jsonPayload)
    if (!landingUrl) {
      sendJson(res, 502, {
        error: {
          code: 'BID_INVALID_RESPONSE',
          message: 'Runtime bid response does not include landingUrl.',
        },
      })
      return
    }

    const responseHeaders = stripResponseHopByHopHeaders(
      Object.fromEntries(upstreamResponse.headers.entries()),
    )
    res.statusCode = status
    for (const [key, value] of Object.entries(responseHeaders)) {
      res.setHeader(key, value)
    }
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(normalizedPayload))
  } catch {
    sendJson(res, 502, {
      error: {
        code: 'NETWORK_BLOCKED',
        message: 'Failed to reach runtime domain /api/v2/bid.',
      },
    })
  }
}

export default async function dashboardApiProxyHandler(req, res) {
  const method = cleanText(req.method || 'GET').toUpperCase()
  const pathname = readReqPathname(req)

  if (pathname === '/api/v1/public/runtime-domain/verify-and-bind' && method === 'POST') {
    await handleRuntimeDomainVerifyAndBind(req, res)
    return
  }
  if (pathname === '/api/v1/public/sdk/bootstrap' && method === 'GET') {
    handleSdkBootstrap(req, res)
    return
  }
  if (pathname === '/api/v2/bid' && method === 'POST') {
    await handleRuntimeBidProxy(req, res)
    return
  }

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
