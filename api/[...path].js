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
const DEFAULT_PLACEMENT_ID = 'chat_from_answer_v1'
const DEFAULT_KEY_NAME = 'runtime-prod'
const DEFAULT_RUNTIME_GATEWAY_HOST = 'runtime-gateway.tappy.ai'
const RUNTIME_VERIFY_TIMEOUT_MS = 8_000
const RUNTIME_BINDING_STORE_TIMEOUT_MS = 2_500
const RUNTIME_BINDING_CACHE_TTL_MS = 30_000
const URL_IN_TEXT_RE = /(https?:\/\/[^\s"'<>]+)/i
const PROBE_HEADERS_MAX_KEYS = 2
const PROBE_HEADERS_MAX_BYTES = 2_048
const DEFAULT_BIND_STATUS = 'pending'
const UNBOUND_BIND_STATUS = 'unbound'

const runtimeDomainBindings = new Map()
const runtimeBindingCache = new Map()
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
  runtimeBindingCache.clear()
}

function isAllowedProbeHeader(headerName) {
  const normalized = normalizeHost(headerName)
  if (!normalized) return false
  if (HOP_BY_HOP_HEADERS.has(normalized)) return false
  if (normalized === 'content-length') return false
  if (normalized === 'host') return false
  return normalized === 'authorization'
    || normalized.startsWith('x-')
    || normalized.startsWith('cf-')
}

function sanitizeProbeHeaders(source = {}) {
  const input = source && typeof source === 'object' && !Array.isArray(source)
    ? source
    : {}
  const entries = []
  let bytes = 0

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = cleanText(rawKey).toLowerCase()
    if (!key) continue

    if (!isAllowedProbeHeader(key)) {
      throw createRuntimeError('PROBE_HEADERS_INVALID', `Probe header "${key}" is not allowed.`)
    }

    const value = cleanText(rawValue)
    if (!value) continue
    bytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8')
    entries.push([key, value])
  }

  if (entries.length > PROBE_HEADERS_MAX_KEYS) {
    throw createRuntimeError('PROBE_HEADERS_INVALID', `Only ${PROBE_HEADERS_MAX_KEYS} probe headers are allowed.`)
  }
  if (bytes > PROBE_HEADERS_MAX_BYTES) {
    throw createRuntimeError('PROBE_HEADERS_INVALID', 'Probe headers exceed size limit.')
  }

  return Object.fromEntries(entries)
}

function encodeProbeHeaders(headers = {}) {
  const payload = JSON.stringify(headers || {})
  return Buffer.from(payload, 'utf8').toString('base64')
}

function decodeProbeHeaders(encodedValue = '') {
  const encoded = cleanText(encodedValue)
  if (!encoded) return {}
  try {
    const raw = Buffer.from(encoded, 'base64').toString('utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
  } catch {
    return {}
  }
}

function makeLegacyProbeCode(code = '') {
  const normalized = cleanText(code).toUpperCase()
  if (!normalized) return ''
  if (normalized === 'AUTH_401_403') return 'AUTH_FORBIDDEN'
  if (['BID_INVALID_RESPONSE_JSON', 'LANDING_URL_MISSING'].includes(normalized)) {
    return 'BID_INVALID_RESPONSE'
  }
  if ([
    'EGRESS_BLOCKED',
    'ENDPOINT_404',
    'METHOD_405',
    'CORS_BLOCKED',
    'UPSTREAM_5XX',
  ].includes(normalized)) {
    return 'NETWORK_BLOCKED'
  }
  return normalized
}

function buildNextActions(code = '') {
  const normalized = cleanText(code).toUpperCase()
  switch (normalized) {
    case 'ENDPOINT_404':
      return [
        'Ensure runtime domain exposes POST /api/v2/bid.',
        'Confirm deployment routes include /api/v2/bid.',
      ]
    case 'METHOD_405':
      return [
        'Allow POST method on /api/v2/bid.',
        'Verify platform middleware does not block non-GET requests.',
      ]
    case 'AUTH_401_403':
      return [
        'Verify Runtime API key is active and has bid permission.',
        'Check Authorization header format: Bearer <MEDIATION_API_KEY>.',
      ]
    case 'UPSTREAM_5XX':
      return [
        'Inspect runtime server logs for /api/v2/bid failures.',
        'Retry probe after runtime service health returns to normal.',
      ]
    case 'BID_INVALID_RESPONSE_JSON':
      return [
        'Return valid JSON body from /api/v2/bid.',
        'Set response Content-Type to application/json.',
      ]
    case 'LANDING_URL_MISSING':
      return [
        'Include landingUrl in /api/v2/bid response.',
        'Or provide url/link so control plane can normalize it.',
      ]
    case 'EGRESS_BLOCKED':
      return [
        'Run Browser Probe to verify user-side reachability.',
        'If Browser Probe passes, allow-list control-plane egress IPs or relax edge protection.',
      ]
    case 'CORS_BLOCKED':
      return [
        'Allow dashboard origin in Access-Control-Allow-Origin for browser probe requests.',
        'Or skip browser probe and rely on server probe diagnostics for production runtime checks.',
      ]
    case 'PROBE_HEADERS_INVALID':
      return [
        'Use up to 2 probe headers with allowed prefixes (x- or cf- or authorization).',
        'Remove host/content-length/connection related headers.',
      ]
    default:
      return [
        'Retry probe and inspect runtime logs.',
        'Confirm /api/v2/bid accepts POST and returns a usable landing URL.',
      ]
  }
}

function createProbeResult(source, input = {}) {
  return {
    source: cleanText(source) || 'server',
    ok: Boolean(input.ok),
    code: cleanText(input.code) || 'EGRESS_BLOCKED',
    httpStatus: Number(input.httpStatus || 0) || undefined,
    detail: cleanText(input.detail),
    landingUrl: cleanText(input.landingUrl),
  }
}

function classifyHttpProbeError(statusCode) {
  const status = Number(statusCode || 0)
  if (status === 404) return 'ENDPOINT_404'
  if (status === 405) return 'METHOD_405'
  if (status === 401 || status === 403) return 'AUTH_401_403'
  if (status >= 500) return 'UPSTREAM_5XX'
  return 'EGRESS_BLOCKED'
}

function normalizeBrowserProbePayload(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {}
  return createProbeResult('browser', {
    ok: source.ok === true,
    code: cleanText(source.code) || 'EGRESS_BLOCKED',
    httpStatus: Number(source.httpStatus || 0) || 0,
    detail: cleanText(source.detail),
    landingUrl: cleanText(source.landingUrl),
  })
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

function createRuntimeError(failureCode, message = '', details = {}) {
  const error = new Error(message || failureCode)
  error.failureCode = failureCode
  if (details && typeof details === 'object') {
    Object.assign(error, details)
  }
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

async function probeBid(runtimeBaseUrl, placementId, authorization, deps, options = {}) {
  const probeHeaders = sanitizeProbeHeaders(options.probeHeaders || {})
  const outboundHeaders = {
    ...probeHeaders,
    authorization,
    'content-type': 'application/json; charset=utf-8',
  }
  const probeResponse = await deps.fetch(`${runtimeBaseUrl}/api/v2/bid`, {
    method: 'POST',
    headers: outboundHeaders,
    body: JSON.stringify(createBidProbePayload(placementId)),
  }).catch((error) => {
    if (error?.failureCode) throw error
    throw createRuntimeError('EGRESS_BLOCKED', 'Runtime bid probe failed.', {
      detail: error instanceof Error ? error.message : 'Network failure',
      legacyCode: 'NETWORK_BLOCKED',
    })
  })

  if (!probeResponse) {
    throw createRuntimeError('EGRESS_BLOCKED', 'Runtime bid probe failed.', {
      legacyCode: 'NETWORK_BLOCKED',
    })
  }

  if (!probeResponse.ok) {
    const code = classifyHttpProbeError(probeResponse.status)
    throw createRuntimeError(code, `Runtime bid probe failed with status ${probeResponse.status}.`, {
      httpStatus: Number(probeResponse.status || 0),
      legacyCode: makeLegacyProbeCode(code),
    })
  }

  const parsed = await readJsonResponse(probeResponse)
  if (!parsed || typeof parsed !== 'object') {
    throw createRuntimeError('BID_INVALID_RESPONSE_JSON', 'Runtime bid response is not JSON.', {
      httpStatus: Number(probeResponse.status || 0),
      legacyCode: 'BID_INVALID_RESPONSE',
    })
  }

  const { landingUrl, payload } = normalizeBidPayload(parsed)
  if (!landingUrl) {
    throw createRuntimeError('LANDING_URL_MISSING', 'Runtime bid response does not contain landingUrl.', {
      httpStatus: Number(probeResponse.status || 0),
      legacyCode: 'BID_INVALID_RESPONSE',
    })
  }

  return createProbeResult('server', {
    ok: true,
    code: 'VERIFIED',
    httpStatus: Number(probeResponse.status || 200),
    detail: 'Runtime bid probe succeeded.',
    landingUrl,
    payload,
  })
}

function toProbeFailureResult(error, source = 'server') {
  const code = cleanText(error?.failureCode || '').toUpperCase() || 'EGRESS_BLOCKED'
  return createProbeResult(source, {
    ok: false,
    code,
    httpStatus: Number(error?.httpStatus || 0),
    detail: cleanText(error?.message || error?.detail || 'Probe failed'),
  })
}

function withProbeCompatibility(payload = {}) {
  const probeCode = cleanText(payload?.failureCode || payload?.probeResult?.code || '')
  const legacyCode = cleanText(payload?.legacyCode || makeLegacyProbeCode(probeCode))
  if (!legacyCode || legacyCode === probeCode) {
    return payload
  }
  return {
    ...payload,
    legacyCode,
  }
}

function computeProbeFinalStatus(serverProbe, browserProbe) {
  const serverOk = Boolean(serverProbe?.ok)
  const browserOk = Boolean(browserProbe?.ok)

  if (serverOk) {
    return {
      status: 'verified',
      code: 'VERIFIED',
      source: 'server',
    }
  }
  if (!serverOk && browserOk) {
    return {
      status: 'pending',
      code: 'EGRESS_BLOCKED',
      source: 'server',
    }
  }
  return {
    status: 'pending',
    code: cleanText(serverProbe?.code || 'EGRESS_BLOCKED'),
    source: 'server',
  }
}

function makeBindingSnapshot(existing = {}, patch = {}) {
  const nowIso = new Date().toISOString()
  const keyHash = cleanText(patch.keyHash || existing.keyHash)
  return {
    keyHash,
    tenantId: cleanText(patch.tenantId || existing.tenantId),
    runtimeBaseUrl: cleanText(patch.runtimeBaseUrl || existing.runtimeBaseUrl),
    placementId: cleanText(patch.placementId || existing.placementId || DEFAULT_PLACEMENT_ID),
    keyScope: 'tenant',
    bindStatus: normalizeBindStatus(patch.bindStatus || existing.bindStatus || DEFAULT_BIND_STATUS),
    verifiedAt: cleanText(patch.verifiedAt ?? existing.verifiedAt),
    lastProbeAt: cleanText(patch.lastProbeAt ?? existing.lastProbeAt),
    lastProbeCode: cleanText(patch.lastProbeCode ?? existing.lastProbeCode),
    lastProbeHttpStatus: Number(patch.lastProbeHttpStatus ?? existing.lastProbeHttpStatus ?? 0) || 0,
    probeHeadersEncrypted: cleanText(patch.probeHeadersEncrypted ?? existing.probeHeadersEncrypted),
    probeDiagnostics: patch.probeDiagnostics || existing.probeDiagnostics || null,
    createdAt: cleanText(existing.createdAt || patch.createdAt || nowIso),
    updatedAt: cleanText(patch.updatedAt || nowIso),
  }
}

function projectBindingForResponse(binding = {}) {
  return {
    tenantId: binding.tenantId,
    keyScope: binding.keyScope || 'tenant',
    runtimeBaseUrl: binding.runtimeBaseUrl,
    bindStatus: normalizeBindStatus(binding.bindStatus || DEFAULT_BIND_STATUS),
    placementDefaults: {
      placementId: binding.placementId || DEFAULT_PLACEMENT_ID,
    },
  }
}

function normalizeBindStatus(status) {
  const normalized = cleanText(status).toLowerCase()
  if (normalized === 'verified') return 'verified'
  if (normalized === 'pending') return 'pending'
  if (normalized === 'failed') return 'failed'
  if (normalized === UNBOUND_BIND_STATUS) return UNBOUND_BIND_STATUS
  return DEFAULT_BIND_STATUS
}

function hashRuntimeApiKey(authorization = '') {
  const token = cleanText(authorization).replace(/^bearer\s+/i, '')
  if (!token) return ''
  return createHash('sha256').update(token).digest('hex')
}

function getBindingCacheKey(authorization = '') {
  return normalizeAuthorization(authorization)
}

function readRuntimeBindingCache(authorization = '') {
  const cacheKey = getBindingCacheKey(authorization)
  if (!cacheKey) return undefined
  const cacheEntry = runtimeBindingCache.get(cacheKey)
  if (!cacheEntry) return undefined
  if (cacheEntry.expiresAt <= Date.now()) {
    runtimeBindingCache.delete(cacheKey)
    return undefined
  }
  return cacheEntry.binding
}

function writeRuntimeBindingCache(authorization = '', binding = null) {
  const cacheKey = getBindingCacheKey(authorization)
  if (!cacheKey) return
  runtimeBindingCache.set(cacheKey, {
    binding: binding || null,
    expiresAt: Date.now() + RUNTIME_BINDING_CACHE_TTL_MS,
  })
}

function buildRuntimeBindingStoreUrl(upstreamBaseUrl = '') {
  const normalized = cleanText(upstreamBaseUrl)
  if (!normalized) return ''
  try {
    const target = new URL(normalized)
    const basePath = target.pathname.replace(/\/$/, '')
    target.pathname = basePath.endsWith('/api')
      ? `${basePath}/v1/public/runtime-domain/binding`
      : `${basePath}/api/v1/public/runtime-domain/binding`
    target.search = ''
    target.hash = ''
    return target.toString()
  } catch {
    return ''
  }
}

function normalizeRuntimeBindingStorePayload(payload = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {}
  const candidate = source.binding && typeof source.binding === 'object' && !Array.isArray(source.binding)
    ? source.binding
    : source

  const hasUsefulFields = Boolean(
    cleanText(candidate.runtimeBaseUrl)
    || cleanText(candidate.tenantId)
    || cleanText(candidate.placementId)
    || cleanText(candidate.bindStatus),
  )
  if (!hasUsefulFields) return null
  return makeBindingSnapshot({}, candidate)
}

async function readRuntimeBindingFromStore(authorization = '') {
  const normalizedAuthorization = normalizeAuthorization(authorization)
  const upstreamBaseUrl = resolveUpstreamBaseUrl()
  const targetUrl = buildRuntimeBindingStoreUrl(upstreamBaseUrl)
  if (!normalizedAuthorization || !targetUrl) return { ok: false, binding: null }

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort('Runtime binding store read timeout')
  }, RUNTIME_BINDING_STORE_TIMEOUT_MS)

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        authorization: normalizedAuthorization,
        accept: 'application/json',
      },
      signal: controller.signal,
    })

    if (response.status === 404) return { ok: true, binding: null }
    if (!response.ok) return { ok: false, binding: null }

    const payload = await readJsonResponse(response)
    const binding = normalizeRuntimeBindingStorePayload(payload || {})
    return { ok: true, binding }
  } catch {
    return { ok: false, binding: null }
  } finally {
    clearTimeout(timer)
  }
}

async function writeRuntimeBindingToStore(authorization = '', binding = null) {
  const normalizedAuthorization = normalizeAuthorization(authorization)
  if (!normalizedAuthorization || !binding) return { ok: false, binding: null }

  const upstreamBaseUrl = resolveUpstreamBaseUrl()
  const targetUrl = buildRuntimeBindingStoreUrl(upstreamBaseUrl)
  if (!targetUrl) return { ok: false, binding: null }

  const snapshot = makeBindingSnapshot(binding, {
    keyHash: cleanText(binding.keyHash || hashRuntimeApiKey(normalizedAuthorization)),
    updatedAt: new Date().toISOString(),
  })

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort('Runtime binding store write timeout')
  }, RUNTIME_BINDING_STORE_TIMEOUT_MS)

  try {
    const response = await fetch(targetUrl, {
      method: 'PUT',
      headers: {
        authorization: normalizedAuthorization,
        'content-type': 'application/json; charset=utf-8',
        accept: 'application/json',
      },
      body: JSON.stringify({
        binding: snapshot,
      }),
      signal: controller.signal,
    })

    if (!response.ok) return { ok: false, binding: snapshot }
    const payload = await readJsonResponse(response)
    const normalized = normalizeRuntimeBindingStorePayload(payload || {})
    return { ok: true, binding: normalized || snapshot }
  } catch {
    return { ok: false, binding: snapshot }
  } finally {
    clearTimeout(timer)
  }
}

async function getRuntimeBindingByAuthorization(authorization = '', options = {}) {
  const normalizedAuthorization = normalizeAuthorization(authorization)
  if (!normalizedAuthorization) return null

  const cached = readRuntimeBindingCache(normalizedAuthorization)
  if (cached !== undefined) return cached || null

  const localBinding = runtimeDomainBindings.get(normalizedAuthorization) || null
  const preferStore = options?.preferStore !== false

  if (!preferStore) {
    writeRuntimeBindingCache(normalizedAuthorization, localBinding)
    return localBinding
  }

  const storeResult = await readRuntimeBindingFromStore(normalizedAuthorization)
  if (storeResult.ok) {
    const binding = storeResult.binding || localBinding || null
    if (binding) {
      runtimeDomainBindings.set(normalizedAuthorization, binding)
    }
    writeRuntimeBindingCache(normalizedAuthorization, binding)
    return binding
  }

  writeRuntimeBindingCache(normalizedAuthorization, localBinding)
  return localBinding
}

async function setRuntimeBindingByAuthorization(authorization = '', binding = null, options = {}) {
  const normalizedAuthorization = normalizeAuthorization(authorization)
  if (!normalizedAuthorization || !binding) return null

  const currentBinding = runtimeDomainBindings.get(normalizedAuthorization) || {}
  const snapshot = makeBindingSnapshot(currentBinding, {
    ...binding,
    keyHash: cleanText(binding.keyHash || currentBinding.keyHash || hashRuntimeApiKey(normalizedAuthorization)),
    updatedAt: new Date().toISOString(),
  })

  runtimeDomainBindings.set(normalizedAuthorization, snapshot)
  writeRuntimeBindingCache(normalizedAuthorization, snapshot)

  if (options?.persist === false) return snapshot

  const storeResult = await writeRuntimeBindingToStore(normalizedAuthorization, snapshot)
  const persisted = storeResult.binding || snapshot
  runtimeDomainBindings.set(normalizedAuthorization, persisted)
  writeRuntimeBindingCache(normalizedAuthorization, persisted)
  return persisted
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
  if (!explicit) return ''
  try {
    const parsed = new URL(explicit)
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

function shouldEnableManagedRuntimeFallback(env = process.env) {
  return cleanText(env?.MEDIATION_RUNTIME_ALLOW_MANAGED_FALLBACK) !== '0'
}

function buildManagedBidTargetUrl(upstreamBaseUrl) {
  const normalizedUpstreamBaseUrl = cleanText(upstreamBaseUrl)
  if (!normalizedUpstreamBaseUrl) return ''
  try {
    const target = new URL(normalizedUpstreamBaseUrl)
    const basePath = target.pathname.replace(/\/$/, '')
    target.pathname = basePath.endsWith('/api')
      ? `${basePath}/v2/bid`
      : `${basePath}/api/v2/bid`
    target.search = ''
    target.hash = ''
    return target.toString()
  } catch {
    return ''
  }
}

function buildRuntimeRouteFailureDetails(binding = {}) {
  const bindStatus = normalizeBindStatus(binding?.bindStatus || UNBOUND_BIND_STATUS)
  return {
    bindStatus,
    nextActions: bindStatus === UNBOUND_BIND_STATUS
      ? [
        'Set MEDIATION_MANAGED_RUNTIME_BASE_URL to enable default managed routing for unbound API keys.',
        'Or bind a custom runtime domain via /api/v1/public/runtime-domain/verify-and-bind.',
      ]
      : [
        'Set MEDIATION_MANAGED_RUNTIME_BASE_URL to allow managed fallback for non-verified bindings.',
        'Run runtime-domain probe and fix the reported probe error.',
      ],
  }
}

function resolveRuntimeRoute(binding = null) {
  const resolvedBinding = binding || null
  const bindStatus = normalizeBindStatus(resolvedBinding?.bindStatus || UNBOUND_BIND_STATUS)
  const customerRuntimeBaseUrl = cleanText(resolvedBinding?.runtimeBaseUrl)
  const managedFallbackEnabled = shouldEnableManagedRuntimeFallback()
  const managedRuntimeBaseUrl = managedFallbackEnabled
    ? resolveManagedRuntimeBaseUrl()
    : ''

  if (bindStatus === 'verified' && customerRuntimeBaseUrl) {
    return {
      ok: true,
      runtimeSource: 'customer',
      runtimeBaseUrl: customerRuntimeBaseUrl,
      customerRuntimeBaseUrl,
      bindStatus: 'verified',
      binding: resolvedBinding,
    }
  }

  if (resolvedBinding && bindStatus !== 'verified') {
    if (managedRuntimeBaseUrl) {
      return {
        ok: true,
        runtimeSource: 'managed_fallback',
        runtimeBaseUrl: managedRuntimeBaseUrl,
        customerRuntimeBaseUrl: customerRuntimeBaseUrl || undefined,
        bindStatus,
        binding: resolvedBinding,
      }
    }
    const failureDetails = buildRuntimeRouteFailureDetails(resolvedBinding)
    return {
      ok: false,
      code: 'MANAGED_RUNTIME_NOT_CONFIGURED',
      message: 'Managed runtime fallback is not configured for this API key.',
      bindStatus: failureDetails.bindStatus,
      nextActions: failureDetails.nextActions,
      binding: resolvedBinding,
    }
  }

  if (managedRuntimeBaseUrl) {
    return {
      ok: true,
      runtimeSource: 'managed_default',
      runtimeBaseUrl: managedRuntimeBaseUrl,
      customerRuntimeBaseUrl: '',
      bindStatus: UNBOUND_BIND_STATUS,
      binding: null,
    }
  }

  const failureDetails = buildRuntimeRouteFailureDetails({})
  return {
    ok: false,
    code: 'MANAGED_RUNTIME_NOT_CONFIGURED',
    message: 'Managed runtime default route is not configured for this API key.',
    bindStatus: failureDetails.bindStatus,
    nextActions: failureDetails.nextActions,
    binding: null,
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

function getRuntimeGatewayHost(env = process.env) {
  const configured = cleanText(env?.MEDIATION_RUNTIME_GATEWAY_HOST)
  return normalizeHost(configured || DEFAULT_RUNTIME_GATEWAY_HOST)
}

function shouldRequireGatewayCname(env = process.env) {
  return cleanText(env?.MEDIATION_RUNTIME_REQUIRE_GATEWAY_CNAME) === '1'
}

function applyProbeStatusToChecks(checks, probeResult) {
  const next = {
    ...(checks || createChecks()),
  }
  if (!probeResult || typeof probeResult !== 'object') return next
  const code = cleanText(probeResult.code).toUpperCase()
  if (probeResult.ok) {
    next.authOk = true
    next.bidOk = true
    next.landingUrlOk = Boolean(cleanText(probeResult.landingUrl))
    return next
  }
  if (code === 'AUTH_401_403') {
    next.authOk = false
  }
  next.bidOk = false
  next.landingUrlOk = false
  return next
}

async function runServerRuntimeProbe(input = {}) {
  const deps = input.deps || getRuntimeDeps()
  const probe = await probeBid(
    input.runtimeBaseUrl,
    input.placementId,
    input.authorization,
    deps,
    {
      probeHeaders: input.probeHeaders || {},
    },
  )
  return createProbeResult('server', probe)
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
  const tenantId = makeTenantId(authorization || 'runtime', deps)

  let probeHeaders = {}
  try {
    probeHeaders = sanitizeProbeHeaders(payload?.probeHeaders || {})
  } catch (error) {
    const probeResult = toProbeFailureResult(error, 'server')
    sendJson(res, 200, withProbeCompatibility({
      status: 'failed',
      bindStage: 'rejected',
      runtimeBaseUrl,
      checks,
      requestId,
      failureCode: probeResult.code,
      probeResult,
      nextActions: buildNextActions(probeResult.code),
    }))
    return
  }

  if (!authorization) {
    const probeResult = createProbeResult('server', {
      ok: false,
      code: 'AUTH_401_403',
      detail: 'Authorization header is required.',
    })
    sendJson(res, 200, withProbeCompatibility({
      status: 'failed',
      bindStage: 'rejected',
      runtimeBaseUrl,
      checks,
      requestId,
      failureCode: probeResult.code,
      probeResult,
      nextActions: buildNextActions(probeResult.code),
    }))
    return
  }

  if (!normalizedDomain.ok) {
    const probeResult = createProbeResult('server', {
      ok: false,
      code: normalizedDomain.failureCode || 'CNAME_MISMATCH',
      detail: 'Runtime domain is invalid.',
    })
    sendJson(res, 200, withProbeCompatibility({
      status: 'failed',
      bindStage: 'rejected',
      runtimeBaseUrl,
      checks,
      requestId,
      failureCode: probeResult.code,
      probeResult,
      nextActions: buildNextActions(probeResult.code),
    }))
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

    const existingBinding = await getRuntimeBindingByAuthorization(authorization) || {}
    const pendingBinding = makeBindingSnapshot(existingBinding, {
      tenantId: existingBinding.tenantId || tenantId,
      runtimeBaseUrl,
      placementId,
      bindStatus: 'pending',
      verifiedAt: '',
      lastProbeAt: new Date().toISOString(),
      probeHeadersEncrypted: encodeProbeHeaders(probeHeaders),
    })
    await setRuntimeBindingByAuthorization(authorization, pendingBinding)

    let serverProbe
    try {
      serverProbe = await runServerRuntimeProbe({
        runtimeBaseUrl,
        placementId,
        authorization,
        deps,
        probeHeaders,
      })
    } catch (error) {
      serverProbe = toProbeFailureResult(error, 'server')
      const updatedPendingBinding = makeBindingSnapshot(pendingBinding, {
        bindStatus: 'pending',
        lastProbeAt: new Date().toISOString(),
        lastProbeCode: serverProbe.code,
        lastProbeHttpStatus: Number(serverProbe.httpStatus || 0),
        probeDiagnostics: {
          serverProbe,
        },
      })
      await setRuntimeBindingByAuthorization(authorization, updatedPendingBinding)
      const checksWithProbe = applyProbeStatusToChecks(checks, serverProbe)
      sendJson(res, 200, withProbeCompatibility({
        status: 'pending',
        bindStage: 'probe_failed',
        runtimeBaseUrl,
        checks: checksWithProbe,
        requestId,
        failureCode: serverProbe.code,
        probeResult: serverProbe,
        nextActions: buildNextActions(serverProbe.code),
        ...projectBindingForResponse(updatedPendingBinding),
      }))
      return
    }

    const checksWithProbe = applyProbeStatusToChecks(checks, serverProbe)
    const verifiedBinding = makeBindingSnapshot(pendingBinding, {
      bindStatus: 'verified',
      verifiedAt: new Date().toISOString(),
      lastProbeAt: new Date().toISOString(),
      lastProbeCode: serverProbe.code,
      lastProbeHttpStatus: Number(serverProbe.httpStatus || 0),
      probeDiagnostics: {
        serverProbe,
      },
    })
    await setRuntimeBindingByAuthorization(authorization, verifiedBinding)

    sendJson(res, 200, withProbeCompatibility({
      status: 'verified',
      bindStage: 'bound',
      runtimeBaseUrl,
      checks: checksWithProbe,
      requestId,
      landingUrlSample: serverProbe.landingUrl,
      probeResult: serverProbe,
      nextActions: [],
      ...projectBindingForResponse(verifiedBinding),
    }))
  } catch (error) {
    const probeResult = toProbeFailureResult(error, 'server')
    const checksWithProbe = applyProbeStatusToChecks(checks, probeResult)
    sendJson(res, 200, withProbeCompatibility({
      status: 'failed',
      bindStage: 'rejected',
      runtimeBaseUrl,
      checks: checksWithProbe,
      requestId,
      failureCode: probeResult.code,
      probeResult,
      nextActions: buildNextActions(probeResult.code),
      ...projectBindingForResponse(makeBindingSnapshot({}, {
        tenantId,
        runtimeBaseUrl,
        placementId,
        bindStatus: 'failed',
      })),
    }))
  }
}

async function handleRuntimeDomainProbe(req, res) {
  const requestId = createRequestId('req_runtime_probe')
  const deps = getRuntimeDeps()
  const requestBody = await readRequestBody(req)
  const payload = parseJsonBody(requestBody) || {}
  const authorization = normalizeAuthorization(readHeaderValue(req.headers, 'authorization'))
  if (!authorization) {
    sendJson(res, 401, {
      error: {
        code: 'AUTH_401_403',
        message: 'Authorization header is required.',
      },
    })
    return
  }

  const binding = await getRuntimeBindingByAuthorization(authorization) || {}
  const normalizedDomain = cleanText(payload?.domain)
    ? normalizeRuntimeDomain(payload?.domain)
    : null
  if (normalizedDomain && !normalizedDomain.ok) {
    sendJson(res, 200, withProbeCompatibility({
      status: 'failed',
      finalStatus: 'failed',
      requestId,
      failureCode: normalizedDomain.failureCode || 'CNAME_MISMATCH',
      serverProbe: createProbeResult('server', {
        ok: false,
        code: normalizedDomain.failureCode || 'CNAME_MISMATCH',
        detail: 'Runtime domain is invalid.',
      }),
      nextActions: buildNextActions(normalizedDomain.failureCode || 'CNAME_MISMATCH'),
    }))
    return
  }

  const runtimeBaseUrl = normalizedDomain?.runtimeBaseUrl || cleanText(binding.runtimeBaseUrl)
  if (!runtimeBaseUrl) {
    sendJson(res, 404, {
      error: {
        code: 'RUNTIME_DOMAIN_NOT_BOUND',
        message: 'Runtime domain is not bound for this API key.',
      },
    })
    return
  }

  const placementId = cleanText(payload?.placementId || binding.placementId || DEFAULT_PLACEMENT_ID)
  let probeHeaders = {}
  try {
    const incomingProbeHeaders = payload?.probeHeaders
    if (incomingProbeHeaders && typeof incomingProbeHeaders === 'object') {
      probeHeaders = sanitizeProbeHeaders(incomingProbeHeaders)
    } else {
      probeHeaders = sanitizeProbeHeaders(decodeProbeHeaders(binding.probeHeadersEncrypted))
    }
  } catch (error) {
    const failedProbe = toProbeFailureResult(error, 'server')
    sendJson(res, 200, withProbeCompatibility({
      status: 'failed',
      finalStatus: 'failed',
      runtimeBaseUrl,
      requestId,
      failureCode: failedProbe.code,
      serverProbe: failedProbe,
      nextActions: buildNextActions(failedProbe.code),
    }))
    return
  }

  let serverProbe
  try {
    serverProbe = await runServerRuntimeProbe({
      runtimeBaseUrl,
      placementId,
      authorization,
      deps,
      probeHeaders,
    })
  } catch (error) {
    serverProbe = toProbeFailureResult(error, 'server')
  }

  const browserProbe = payload?.runBrowserProbe === true
    ? normalizeBrowserProbePayload(payload?.browserProbe || {})
    : null

  const decision = computeProbeFinalStatus(serverProbe, browserProbe)
  const failureCode = decision.status === 'verified' ? '' : decision.code
  const tenantId = cleanText(binding.tenantId) || makeTenantId(authorization, deps)
  const nextBinding = makeBindingSnapshot(binding, {
    tenantId,
    runtimeBaseUrl,
    placementId,
    bindStatus: decision.status === 'verified' ? 'verified' : 'pending',
    verifiedAt: decision.status === 'verified' ? new Date().toISOString() : '',
    lastProbeAt: new Date().toISOString(),
    lastProbeCode: failureCode || 'VERIFIED',
    lastProbeHttpStatus: Number(serverProbe.httpStatus || browserProbe?.httpStatus || 0),
    probeHeadersEncrypted: encodeProbeHeaders(probeHeaders),
    probeDiagnostics: {
      serverProbe,
      browserProbe,
      finalCode: failureCode || 'VERIFIED',
    },
  })
  await setRuntimeBindingByAuthorization(authorization, nextBinding)

  const response = withProbeCompatibility({
    status: decision.status,
    finalStatus: decision.status,
    requestId,
    runtimeBaseUrl,
    failureCode: failureCode || undefined,
    probeResult: decision.status === 'verified'
      ? serverProbe
      : createProbeResult('server', {
        ok: false,
        code: failureCode,
        httpStatus: Number(serverProbe.httpStatus || 0),
        detail: serverProbe.detail,
      }),
    serverProbe,
    browserProbe: browserProbe || undefined,
    nextActions: failureCode ? buildNextActions(failureCode) : [],
    ...projectBindingForResponse(nextBinding),
  })
  sendJson(res, 200, response)
}

function buildRuntimeRouteError(route = {}, requestId = '') {
  return {
    error: {
      code: cleanText(route.code || 'RUNTIME_ROUTE_UNAVAILABLE'),
      message: cleanText(route.message || 'No runtime route is available for this API key.'),
      requestId: cleanText(requestId),
      details: {
        bindStatus: normalizeBindStatus(route.bindStatus || UNBOUND_BIND_STATUS),
        nextActions: Array.isArray(route.nextActions) ? route.nextActions : [],
      },
    },
  }
}

function pickNoFillAction(route = {}, fallbackMessage = '') {
  if (Array.isArray(route.nextActions) && route.nextActions.length > 0) {
    return cleanText(route.nextActions[0])
  }
  return cleanText(fallbackMessage)
}

function buildNoFillResponse(input = {}) {
  return {
    filled: false,
    reasonCode: cleanText(input.reasonCode || 'NO_FILL'),
    reasonMessage: cleanText(input.reasonMessage || 'Ad request returned no fill.'),
    nextAction: cleanText(input.nextAction),
    traceId: cleanText(input.traceId),
    runtimeSource: cleanText(input.runtimeSource || 'unknown'),
  }
}

async function requestRuntimeBid(input = {}) {
  const deps = input.deps || getRuntimeDeps()
  const targetUrl = cleanText(input.targetUrl)
  const requestBody = input.requestBody
  const headers = input.headers || {}
  const usingManagedRuntime = input.usingManagedRuntime === true

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
        errorCode: 'UPSTREAM_NO_FILL',
        errorMessage: 'Runtime bid response returned filled=false.',
        upstreamPayload: jsonPayload,
      }
    }

    const { payload: normalizedPayload, landingUrl } = normalizeBidPayload(jsonPayload)
    if (!landingUrl) {
      return {
        ok: false,
        status: 502,
        errorCode: 'BID_INVALID_RESPONSE',
        errorMessage: 'Runtime bid response does not include landingUrl.',
        upstreamPayload: jsonPayload,
      }
    }

    return {
      ok: true,
      passthrough: false,
      status,
      payload: normalizedPayload,
      landingUrl,
      responseHeaders,
    }
  } catch {
    return {
      ok: false,
      status: 502,
      errorCode: usingManagedRuntime ? 'MANAGED_RUNTIME_UNAVAILABLE' : 'NETWORK_BLOCKED',
      errorMessage: usingManagedRuntime
        ? 'Failed to reach managed runtime /api/v2/bid.'
        : 'Failed to reach runtime domain /api/v2/bid.',
    }
  }
}

async function handleSdkBootstrap(req, res) {
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

  const binding = await getRuntimeBindingByAuthorization(authorization)
  const route = resolveRuntimeRoute(binding)
  if (!route.ok) {
    sendJson(res, 503, buildRuntimeRouteError(route, createRequestId('req_runtime_route')))
    return
  }

  const projectedBinding = binding
    ? projectBindingForResponse(binding)
    : projectBindingForResponse(makeBindingSnapshot({}, {
      bindStatus: UNBOUND_BIND_STATUS,
    }))

  sendJson(res, 200, {
    ...projectedBinding,
    runtimeBaseUrl: route.runtimeBaseUrl,
    runtimeSource: route.runtimeSource,
    customerRuntimeBaseUrl: route.customerRuntimeBaseUrl || undefined,
    lastProbeCode: cleanText(binding?.lastProbeCode),
    bindStatus: route.bindStatus,
  })
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

  const binding = await getRuntimeBindingByAuthorization(authorization)
  const route = resolveRuntimeRoute(binding)
  if (!route.ok) {
    sendJson(res, 503, buildRuntimeRouteError(route, createRequestId('req_runtime_route')))
    return
  }

  const deps = getRuntimeDeps()
  const requestBody = await readRequestBody(req)
  const headers = buildUpstreamHeaders(req)
  headers.authorization = authorization

  const targetUrl = `${cleanText(route.runtimeBaseUrl)}/api/v2/bid`
  const bidResult = await requestRuntimeBid({
    deps,
    targetUrl,
    requestBody,
    headers,
    usingManagedRuntime: route.runtimeSource.startsWith('managed'),
  })

  if (!bidResult.ok) {
    res.setHeader('x-tappy-runtime-source', route.runtimeSource)
    sendJson(res, Number(bidResult.status || 502), {
      error: {
        code: cleanText(bidResult.errorCode || 'NETWORK_BLOCKED'),
        message: cleanText(bidResult.errorMessage || 'Failed to execute runtime bid request.'),
      },
    })
    return
  }

  res.setHeader('x-tappy-runtime-source', route.runtimeSource)
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

async function handleAdBid(req, res) {
  const traceId = createRequestId('req_ad_bid')
  const authorization = normalizeAuthorization(readHeaderValue(req.headers, 'authorization'))
  if (!authorization) {
    sendJson(res, 200, buildNoFillResponse({
      traceId,
      reasonCode: 'AUTH_FORBIDDEN',
      reasonMessage: 'Authorization header is required.',
      nextAction: 'Set Authorization header: Bearer <MEDIATION_API_KEY>.',
      runtimeSource: 'unknown',
    }))
    return
  }

  const binding = await getRuntimeBindingByAuthorization(authorization)
  const route = resolveRuntimeRoute(binding)
  if (!route.ok) {
    const noFill = buildNoFillResponse({
      traceId,
      reasonCode: cleanText(route.code || 'RUNTIME_ROUTE_UNAVAILABLE'),
      reasonMessage: cleanText(route.message || 'No runtime route available for this API key.'),
      nextAction: pickNoFillAction(route),
      runtimeSource: 'none',
    })
    console.warn('[ad-bid][no-fill]', noFill)
    sendJson(res, 200, noFill)
    return
  }

  const deps = getRuntimeDeps()
  const requestBody = await readRequestBody(req)
  const headers = buildUpstreamHeaders(req)
  headers.authorization = authorization

  const bidResult = await requestRuntimeBid({
    deps,
    targetUrl: `${cleanText(route.runtimeBaseUrl)}/api/v2/bid`,
    requestBody,
    headers,
    usingManagedRuntime: route.runtimeSource.startsWith('managed'),
  })

  if (!bidResult.ok || bidResult.passthrough) {
    const noFill = buildNoFillResponse({
      traceId,
      reasonCode: cleanText(bidResult.errorCode || 'BID_INVALID_RESPONSE'),
      reasonMessage: cleanText(bidResult.errorMessage || 'Runtime bid response is not valid JSON.'),
      nextAction: pickNoFillAction(route, 'Retry later or verify runtime route health in dashboard diagnostics.'),
      runtimeSource: route.runtimeSource,
    })
    console.warn('[ad-bid][no-fill]', noFill)
    sendJson(res, 200, noFill)
    return
  }

  sendJson(res, 200, {
    filled: true,
    traceId,
    runtimeSource: route.runtimeSource,
    landingUrl: bidResult.landingUrl,
    requestId: cleanText(bidResult.payload?.requestId || traceId),
    bid: bidResult.payload,
  })
}

export default async function dashboardApiProxyHandler(req, res) {
  const method = cleanText(req.method || 'GET').toUpperCase()
  const pathname = readReqPathname(req)

  if (pathname === '/api/v1/public/runtime-domain/verify-and-bind' && method === 'POST') {
    await handleRuntimeDomainVerifyAndBind(req, res)
    return
  }
  if (pathname === '/api/v1/public/runtime-domain/probe' && method === 'POST') {
    await handleRuntimeDomainProbe(req, res)
    return
  }
  if (pathname === '/api/v1/public/sdk/bootstrap' && method === 'GET') {
    await handleSdkBootstrap(req, res)
    return
  }
  if (pathname === '/api/v2/bid' && method === 'POST') {
    await handleRuntimeBidProxy(req, res)
    return
  }
  if (pathname === '/api/ad/bid' && method === 'POST') {
    await handleAdBid(req, res)
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
