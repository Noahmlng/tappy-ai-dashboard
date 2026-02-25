import { createControlPlaneClient as createContractsControlPlaneClient } from '@ai-network/mediation-sdk-contracts/client'

const API_PROXY_BASE_URL = '/api'
const API_BASE_URL = String(
  import.meta.env.VITE_MEDIATION_CONTROL_PLANE_API_BASE_URL
  || API_PROXY_BASE_URL,
).trim().replace(/\/$/, '')
let dashboardAccessToken = ''

const primaryClient = createContractsControlPlaneClient({
  baseUrl: API_BASE_URL,
})

const hasProxyFallback = (
  API_BASE_URL !== API_PROXY_BASE_URL
  && /^https?:\/\//i.test(API_BASE_URL)
)

const fallbackClient = hasProxyFallback
  ? createContractsControlPlaneClient({ baseUrl: API_PROXY_BASE_URL })
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
