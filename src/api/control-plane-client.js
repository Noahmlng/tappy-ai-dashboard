const API_PROXY_BASE_URL = '/api'
const API_BASE_URL = normalizeApiBaseUrl(
  import.meta.env.VITE_MEDIATION_CONTROL_PLANE_API_BASE_URL || API_PROXY_BASE_URL,
)

let dashboardAccessToken = ''

function normalizeApiBaseUrl(rawBaseUrl) {
  const value = String(rawBaseUrl || '').trim()
  if (!value) return API_PROXY_BASE_URL

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
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
      return API_PROXY_BASE_URL
    }
  }

  const normalized = value.startsWith('/') ? value : `/${value}`
  const pathname = normalized.replace(/\/$/, '')
  if (!pathname || pathname === '/') return API_PROXY_BASE_URL
  if (pathname.endsWith('/api')) return pathname
  return `${pathname}/api`
}

function appendQuery(path, query) {
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

async function requestJson(baseUrl, path, options = {}) {
  const url = `${baseUrl}${appendQuery(path, options.query)}`
  const headers = {
    ...(options.headers || {}),
  }

  let body = options.body
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
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

function createControlPlaneClient(config = {}) {
  const baseUrl = normalizeApiBaseUrl(config.baseUrl)
  let dashboardToken = String(config.dashboardToken || '').trim()

  function authHeaders(extra = {}) {
    return dashboardToken
      ? { ...extra, Authorization: `Bearer ${dashboardToken}` }
      : extra
  }

  function setAccessToken(token) {
    dashboardToken = String(token || '').trim()
  }

  function request(path, options = {}) {
    return requestJson(baseUrl, path, {
      ...options,
      headers: authHeaders(options.headers || {}),
    })
  }

  return {
    setAccessToken,
    health: {
      ping() {
        return request('/health')
      },
    },
    dashboard: {
      getState(query = {}) {
        return request('/v1/dashboard/state', { query })
      },
      getUsageRevenue(query = {}) {
        return request('/v1/dashboard/usage-revenue', { query })
      },
      updatePlacement(placementId, patch = {}) {
        return request(`/v1/dashboard/placements/${encodeURIComponent(placementId)}`, {
          method: 'PUT',
          body: patch,
        })
      },
    },
    credentials: {
      listKeys(query = {}) {
        return request('/v1/public/credentials/keys', { query })
      },
      createKey(payload = {}) {
        return request('/v1/public/credentials/keys', {
          method: 'POST',
          body: payload,
        })
      },
      rotateKey(keyId) {
        return request(`/v1/public/credentials/keys/${encodeURIComponent(keyId)}/rotate`, {
          method: 'POST',
        })
      },
      revokeKey(keyId) {
        return request(`/v1/public/credentials/keys/${encodeURIComponent(keyId)}/revoke`, {
          method: 'POST',
        })
      },
    },
    quickStart: {
      verify(payload = {}) {
        return request('/v1/public/quick-start/verify', {
          method: 'POST',
          body: payload,
        })
      },
    },
    auth: {
      register(payload = {}) {
        return request('/v1/public/dashboard/register', {
          method: 'POST',
          body: payload,
        })
      },
      login(payload = {}) {
        return request('/v1/public/dashboard/login', {
          method: 'POST',
          body: payload,
        })
      },
      me(query = {}) {
        return request('/v1/public/dashboard/me', { query })
      },
      logout() {
        return request('/v1/public/dashboard/logout', {
          method: 'POST',
        })
      },
    },
    agent: {
      issueIntegrationToken(payload = {}) {
        return request('/v1/public/agent/integration-token', {
          method: 'POST',
          body: payload,
        })
      },
      exchangeIntegrationToken(payload = {}) {
        return request('/v1/public/agent/token-exchange', {
          method: 'POST',
          body: payload,
        })
      },
    },
    placements: {
      list(query = {}) {
        return request('/v1/dashboard/placements', { query })
      },
      create(payload = {}) {
        return request('/v1/dashboard/placements', {
          method: 'POST',
          body: payload,
        })
      },
      update(placementId, payload = {}) {
        return request(`/v1/dashboard/placements/${encodeURIComponent(placementId)}`, {
          method: 'PUT',
          body: payload,
        })
      },
    },
  }
}

const primaryClient = createControlPlaneClient({
  baseUrl: API_BASE_URL,
})

const hasProxyFallback = (
  API_BASE_URL !== API_PROXY_BASE_URL
  && /^https?:\/\//i.test(API_BASE_URL)
)

const fallbackClient = hasProxyFallback
  ? createControlPlaneClient({ baseUrl: API_PROXY_BASE_URL })
  : null

export function setDashboardAccessToken(token) {
  dashboardAccessToken = String(token || '').trim()
}

export function getDashboardAccessToken() {
  return dashboardAccessToken
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

function isLikelyNetworkError(error) {
  if (error instanceof TypeError) return true
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase()
  return message.includes('failed to fetch') || message.includes('networkerror')
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

async function withClientCall(callFactory) {
  primaryClient.setAccessToken(dashboardAccessToken)
  try {
    return await callFactory(primaryClient)
  } catch (error) {
    const shouldRetryViaProxy = fallbackClient && isLikelyNetworkError(error)
    if (!shouldRetryViaProxy) throw normalizeControlPlaneError(error)

    fallbackClient.setAccessToken(dashboardAccessToken)
    try {
      return await callFactory(fallbackClient)
    } catch (fallbackError) {
      throw normalizeControlPlaneError(fallbackError)
    }
  }
}

export const controlPlaneClient = {
  health: {
    ping() {
      return withClientCall((client) => client.health.ping())
    },
  },
  dashboard: {
    getState(query) {
      return withClientCall((client) => client.dashboard.getState(query || {}))
    },
    getUsageRevenue(query) {
      return withClientCall((client) => client.dashboard.getUsageRevenue(query || {}))
    },
    updatePlacement(placementId, patch) {
      return withClientCall((client) => client.dashboard.updatePlacement(placementId, patch || {}))
    },
  },
  credentials: {
    listKeys(query) {
      return withClientCall((client) => client.credentials.listKeys(query || {}))
    },
    createKey(payload) {
      return withClientCall((client) => client.credentials.createKey(payload || {}))
    },
    rotateKey(keyId) {
      return withClientCall((client) => client.credentials.rotateKey(keyId))
    },
    revokeKey(keyId) {
      return withClientCall((client) => client.credentials.revokeKey(keyId))
    },
  },
  quickStart: {
    verify(payload) {
      return withClientCall((client) => client.quickStart.verify(payload || {}))
    },
  },
  auth: {
    register(payload) {
      return withClientCall((client) => client.auth.register(payload || {}))
    },
    login(payload) {
      return withClientCall((client) => client.auth.login(payload || {}))
    },
    me(query) {
      return withClientCall((client) => client.auth.me(query || {}))
    },
    logout() {
      return withClientCall((client) => client.auth.logout())
    },
  },
  agent: {
    issueIntegrationToken(payload) {
      return withClientCall((client) => client.agent.issueIntegrationToken(payload || {}))
    },
    exchangeIntegrationToken(payload) {
      return withClientCall((client) => client.agent.exchangeIntegrationToken(payload || {}))
    },
  },
  placements: {
    list(query) {
      return withClientCall((client) => client.placements.list(query || {}))
    },
    create(payload) {
      return withClientCall((client) => client.placements.create(payload || {}))
    },
    update(placementId, payload) {
      return withClientCall((client) => client.placements.update(placementId, payload || {}))
    },
  },
}
