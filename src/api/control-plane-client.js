const API_BASE_URL = '/api'
const DASHBOARD_ACCESS_TOKEN_STORAGE_KEY = 'dashboard_access_token'
let dashboardAccessToken = ''

export function appendQuery(path, query) {
  const entries = Object.entries(query || {}).filter(([, value]) => (
    value !== undefined && value !== null && value !== ''
  ))
  if (entries.length === 0) return path

  const params = new URLSearchParams()
  for (const [key, value] of entries) {
    params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

function parseCookieHeader(source) {
  if (!source) return []
  return String(source)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function getCookieValue(name, source) {
  const normalizedName = String(name || '').trim()
  if (!normalizedName) return ''

  const cookieSource = source !== undefined
    ? String(source || '')
    : (typeof document !== 'undefined' ? String(document.cookie || '') : '')

  for (const entry of parseCookieHeader(cookieSource)) {
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) continue
    const key = entry.slice(0, separatorIndex).trim()
    if (key !== normalizedName) continue

    const rawValue = entry.slice(separatorIndex + 1)
    try {
      return decodeURIComponent(rawValue)
    } catch {
      return rawValue
    }
  }

  return ''
}

function shouldAttachCsrfToken(method) {
  const normalizedMethod = String(method || 'GET').toUpperCase()
  return !['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)
}

function readStoredDashboardAccessToken() {
  if (typeof window === 'undefined' || !window?.localStorage) return ''
  try {
    return String(window.localStorage.getItem(DASHBOARD_ACCESS_TOKEN_STORAGE_KEY) || '').trim()
  } catch {
    return ''
  }
}

function getDashboardAccessToken() {
  if (dashboardAccessToken) return dashboardAccessToken
  const stored = readStoredDashboardAccessToken()
  if (stored) {
    dashboardAccessToken = stored
  }
  return dashboardAccessToken
}

export function setDashboardAccessToken(value = '') {
  const nextValue = String(value || '').trim()
  dashboardAccessToken = nextValue

  if (typeof window === 'undefined' || !window?.localStorage) return
  try {
    if (nextValue) {
      window.localStorage.setItem(DASHBOARD_ACCESS_TOKEN_STORAGE_KEY, nextValue)
    } else {
      window.localStorage.removeItem(DASHBOARD_ACCESS_TOKEN_STORAGE_KEY)
    }
  } catch {
    // storage access can fail in private contexts; keep in-memory token only
  }
}

function createRequestHeaders(method, headers = {}) {
  const nextHeaders = {
    ...headers,
  }

  const hasAuthorization = Object.keys(nextHeaders).some((key) => key.toLowerCase() === 'authorization')
  if (!hasAuthorization) {
    const accessToken = getDashboardAccessToken()
    if (accessToken) {
      nextHeaders.Authorization = `Bearer ${accessToken}`
    }
  }

  if (!shouldAttachCsrfToken(method)) return nextHeaders
  const alreadySet = Object.keys(nextHeaders).some((key) => key.toLowerCase() === 'x-csrf-token')
  if (alreadySet) return nextHeaders

  const csrfToken = getCookieValue('dash_csrf')
  if (csrfToken) {
    nextHeaders['x-csrf-token'] = csrfToken
  }
  return nextHeaders
}

async function requestJson(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const url = `${API_BASE_URL}${appendQuery(path, options.query)}`
  const headers = createRequestHeaders(method, options.headers || {})

  let body = options.body
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    credentials: 'include',
  })

  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '')

  if (!response.ok) {
    const message = typeof payload === 'object' && payload
      ? payload?.error?.message || payload?.message || `HTTP ${response.status}`
      : `HTTP ${response.status}`

    const error = new Error(message)
    error.status = response.status
    error.payload = payload
    throw error
  }

  return payload
}

const rawControlPlaneClient = {
  health: {
    ping() {
      return requestJson('/health')
    },
  },
  dashboard: {
    getState(query = {}) {
      return requestJson('/v1/dashboard/state', { query })
    },
    getUsageRevenue(query = {}) {
      return requestJson('/v1/dashboard/usage-revenue', { query })
    },
    updatePlacement(placementId, patch = {}) {
      return requestJson(`/v1/dashboard/placements/${encodeURIComponent(placementId)}`, {
        method: 'PUT',
        body: patch,
      })
    },
  },
  credentials: {
    listKeys(query = {}) {
      return requestJson('/v1/public/credentials/keys', { query })
    },
    createKey(payload = {}) {
      return requestJson('/v1/public/credentials/keys', {
        method: 'POST',
        body: payload,
      })
    },
    rotateKey(keyId) {
      return requestJson(`/v1/public/credentials/keys/${encodeURIComponent(keyId)}/rotate`, {
        method: 'POST',
      })
    },
    revokeKey(keyId) {
      return requestJson(`/v1/public/credentials/keys/${encodeURIComponent(keyId)}/revoke`, {
        method: 'POST',
      })
    },
  },
  quickStart: {
    verify(payload = {}) {
      return requestJson('/v1/public/quick-start/verify', {
        method: 'POST',
        body: payload,
      })
    },
  },
  auth: {
    register(payload = {}) {
      return requestJson('/v1/public/dashboard/register', {
        method: 'POST',
        body: payload,
      })
    },
    login(payload = {}) {
      return requestJson('/v1/public/dashboard/login', {
        method: 'POST',
        body: payload,
      })
    },
    me(query = {}) {
      return requestJson('/v1/public/dashboard/me', { query })
    },
    logout() {
      return requestJson('/v1/public/dashboard/logout', {
        method: 'POST',
      })
    },
  },
  placements: {
    list(query = {}) {
      return requestJson('/v1/dashboard/placements', { query })
    },
    create(payload = {}) {
      return requestJson('/v1/dashboard/placements', {
        method: 'POST',
        body: payload,
      })
    },
    update(placementId, payload = {}) {
      return requestJson(`/v1/dashboard/placements/${encodeURIComponent(placementId)}`, {
        method: 'PUT',
        body: payload,
      })
    },
  },
}

export class ControlPlaneApiError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ControlPlaneApiError'
    this.status = Number(details.status || 0)
    this.code = String(details.code || '')
    this.details = details.details || null
  }
}

function normalizeControlPlaneError(error) {
  if (error instanceof ControlPlaneApiError) return error

  const payload = error && typeof error === 'object' ? error.payload : null
  const message = payload?.error?.message
    || (error instanceof Error ? error.message : 'Request failed')

  return new ControlPlaneApiError(message, {
    status: Number(error?.status || 0),
    code: String(payload?.error?.code || ''),
    details: payload || null,
  })
}

async function withControlPlaneCall(callFactory) {
  try {
    return await callFactory()
  } catch (error) {
    throw normalizeControlPlaneError(error)
  }
}

export const controlPlaneClient = {
  health: {
    ping() {
      return withControlPlaneCall(() => rawControlPlaneClient.health.ping())
    },
  },
  dashboard: {
    getState(query) {
      return withControlPlaneCall(() => rawControlPlaneClient.dashboard.getState(query || {}))
    },
    getUsageRevenue(query) {
      return withControlPlaneCall(() => rawControlPlaneClient.dashboard.getUsageRevenue(query || {}))
    },
    updatePlacement(placementId, patch) {
      return withControlPlaneCall(() => rawControlPlaneClient.dashboard.updatePlacement(placementId, patch || {}))
    },
  },
  credentials: {
    listKeys(query) {
      return withControlPlaneCall(() => rawControlPlaneClient.credentials.listKeys(query || {}))
    },
    createKey(payload) {
      return withControlPlaneCall(() => rawControlPlaneClient.credentials.createKey(payload || {}))
    },
    rotateKey(keyId) {
      return withControlPlaneCall(() => rawControlPlaneClient.credentials.rotateKey(keyId))
    },
    revokeKey(keyId) {
      return withControlPlaneCall(() => rawControlPlaneClient.credentials.revokeKey(keyId))
    },
  },
  quickStart: {
    verify(payload) {
      return withControlPlaneCall(() => rawControlPlaneClient.quickStart.verify(payload || {}))
    },
  },
  auth: {
    register(payload) {
      return withControlPlaneCall(() => rawControlPlaneClient.auth.register(payload || {}))
    },
    login(payload) {
      return withControlPlaneCall(() => rawControlPlaneClient.auth.login(payload || {}))
    },
    me(query) {
      return withControlPlaneCall(() => rawControlPlaneClient.auth.me(query || {}))
    },
    logout() {
      return withControlPlaneCall(() => rawControlPlaneClient.auth.logout())
    },
  },
  placements: {
    list(query) {
      return withControlPlaneCall(() => rawControlPlaneClient.placements.list(query || {}))
    },
    create(payload) {
      return withControlPlaneCall(() => rawControlPlaneClient.placements.create(payload || {}))
    },
    update(placementId, payload) {
      return withControlPlaneCall(() => rawControlPlaneClient.placements.update(placementId, payload || {}))
    },
  },
}
