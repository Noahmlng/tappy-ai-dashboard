function cleanText(value) {
  return String(value || '').trim()
}

function toTimestamp(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = cleanText(value)
  if (!text) return fallback
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return parsed
  return fallback
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  return fallback
}

function firstText(source, keys = []) {
  for (const key of keys) {
    const value = cleanText(source?.[key])
    if (value) return value
  }
  return ''
}

function linkByPriority(source = {}) {
  const keys = ['targetUrl', 'clickUrl', 'landingUrl', 'trackingUrl', 'url']
  for (let index = 0; index < keys.length; index += 1) {
    const link = cleanText(source?.[keys[index]])
    if (link) return { link, priority: index }
  }
  return { link: '-', priority: Number.POSITIVE_INFINITY }
}

function meaningfulText(value) {
  const text = cleanText(value)
  if (!text || text === '-') return ''
  return text
}

function normalizeInteractionKind(source = {}) {
  const eventType = cleanText(source.eventType).toLowerCase()
  const kind = cleanText(source.kind).toLowerCase()
  const event = cleanText(source.event).toLowerCase()

  if (kind) return kind
  if (eventType === 'redirect_click') return 'click'
  if (eventType === 'postback') return 'postback'
  if (event === 'click') return 'click'
  if (event === 'impression') return 'impression'
  return 'event'
}

function normalizeEventRow(row = {}, index = 0) {
  const timestamp = toTimestamp(
    firstText(row, ['createdAt', 'occurredAt', 'eventAt', 'timestamp']),
    Date.now() - index,
  )
  const kind = normalizeInteractionKind(row)
  const result = firstText(row, ['result', 'status', 'eventStatus', 'postbackStatus']) || '-'

  const clickLink = linkByPriority(row)

  return {
    source: 'event',
    id: firstText(row, ['id', 'eventId']) || `event_${index}`,
    requestId: firstText(row, ['requestId', 'traceId']),
    timestamp,
    timeLabel: firstText(row, ['createdAt', 'occurredAt', 'eventAt']) || '-',
    kind,
    placementId: firstText(row, ['placementId', 'placement']) || '-',
    clickedLink: clickLink.link,
    clickedLinkPriority: clickLink.priority,
    clickStatus: kind === 'click' ? result : '-',
    postbackStatus: kind === 'postback' ? result : '-',
    result,
    revenueUsd: toNumber(row.revenueUsd, 0),
    detail: firstText(row, ['reasonDetail', 'reasonCode', 'reason', 'message']) || '-',
  }
}

function normalizeDecisionRow(row = {}, index = 0) {
  const timestamp = toTimestamp(
    firstText(row, ['createdAt', 'occurredAt', 'eventAt', 'timestamp']),
    Date.now() - index,
  )

  return {
    source: 'decision',
    id: firstText(row, ['id']) || `decision_${index}`,
    requestId: firstText(row, ['requestId', 'traceId']),
    timestamp,
    timeLabel: firstText(row, ['createdAt', 'occurredAt', 'eventAt']) || '-',
    kind: 'decision',
    placementId: firstText(row, ['placementId', 'placement']) || '-',
    clickedLink: '-',
    clickedLinkPriority: Number.POSITIVE_INFINITY,
    clickStatus: '-',
    postbackStatus: '-',
    result: firstText(row, ['result', 'status']) || '-',
    revenueUsd: 0,
    detail: firstText(row, ['reasonDetail', 'reason', 'message']) || '-',
  }
}

function normalizeAuditRow(row = {}, index = 0) {
  const timestamp = toTimestamp(
    firstText(row, ['createdAt', 'occurredAt', 'eventAt', 'timestamp']),
    Date.now() - index,
  )

  return {
    source: 'audit',
    id: firstText(row, ['id', 'auditId']) || `audit_${index}`,
    requestId: firstText(row, ['requestId', 'traceId']),
    timestamp,
    timeLabel: firstText(row, ['createdAt', 'occurredAt', 'eventAt']) || '-',
    kind: 'audit',
    placementId: firstText(row, ['placementId', 'placement']) || '-',
    clickedLink: '-',
    clickedLinkPriority: Number.POSITIVE_INFINITY,
    clickStatus: '-',
    postbackStatus: '-',
    result: firstText(row, ['status', 'result']) || '-',
    revenueUsd: 0,
    detail: firstText(row, ['reasonDetail', 'reason', 'message', 'action']) || '-',
  }
}

function chainKey(row, index) {
  const requestId = cleanText(row.requestId)
  if (requestId) return `request:${requestId}`
  return `fallback:${row.source}:${row.id}:${index}`
}

function computeInteraction(chain) {
  if (cleanText(chain.clickStatus) !== '-') return 'click'
  if (cleanText(chain.postbackStatus) !== '-') return 'postback'
  if (chain.hasImpression) return 'impression'
  if (chain.hasDecision) return 'decision'
  return 'event'
}

export function buildUnifiedLogs(input = {}) {
  const decisionLogs = Array.isArray(input.decisionLogs) ? input.decisionLogs : []
  const placementAuditLogs = Array.isArray(input.placementAuditLogs) ? input.placementAuditLogs : []
  const eventLogs = Array.isArray(input.eventLogs) ? input.eventLogs : []

  const normalizedRows = [
    ...eventLogs.map((row, index) => normalizeEventRow(row, index)),
    ...decisionLogs.map((row, index) => normalizeDecisionRow(row, index)),
    ...placementAuditLogs.map((row, index) => normalizeAuditRow(row, index)),
  ]

  const chains = new Map()
  normalizedRows.forEach((row, index) => {
    const key = chainKey(row, index)
    if (!chains.has(key)) {
      chains.set(key, {
        id: key,
        requestId: cleanText(row.requestId) || '-',
        timestamp: row.timestamp,
        timeLabel: row.timeLabel,
        placementId: cleanText(row.placementId) || '-',
        clickedLink: '-',
        clickedLinkPriority: Number.POSITIVE_INFINITY,
        clickStatus: '-',
        postbackStatus: '-',
        revenueUsd: 0,
        result: cleanText(row.result) || '-',
        detail: cleanText(row.detail) || '-',
        hasImpression: false,
        hasDecision: false,
      })
    }

    const chain = chains.get(key)
    if (row.timestamp >= chain.timestamp) {
      chain.timestamp = row.timestamp
      chain.timeLabel = row.timeLabel
      chain.result = cleanText(row.result) || chain.result
      chain.detail = cleanText(row.detail) || chain.detail
    }

    if (chain.placementId === '-' && cleanText(row.placementId)) {
      chain.placementId = cleanText(row.placementId)
    }

    if (cleanText(row.clickedLink) && row.clickedLinkPriority < chain.clickedLinkPriority) {
      chain.clickedLink = cleanText(row.clickedLink)
      chain.clickedLinkPriority = row.clickedLinkPriority
    }

    if (row.kind === 'click') {
      chain.clickStatus = cleanText(row.clickStatus) || chain.clickStatus
      chain.revenueUsd = Math.max(chain.revenueUsd, toNumber(row.revenueUsd, 0))
    }
    if (row.kind === 'postback') {
      chain.postbackStatus = cleanText(row.postbackStatus) || chain.postbackStatus
      chain.revenueUsd = Math.max(chain.revenueUsd, toNumber(row.revenueUsd, 0))
    }
    if (row.kind === 'impression') {
      chain.hasImpression = true
    }
    if (row.kind === 'decision') {
      chain.hasDecision = true
    }
  })

  return Array.from(chains.values())
    .map((chain) => {
      const interaction = computeInteraction(chain)
      const primaryResult =
        meaningfulText(chain.clickStatus) ||
        meaningfulText(chain.postbackStatus) ||
        meaningfulText(chain.result)
      return {
        id: chain.id,
        timestamp: chain.timestamp,
        timeLabel: chain.timeLabel,
        requestId: chain.requestId,
        placementId: chain.placementId,
        clickedLink: chain.clickedLink,
        clickStatus: chain.clickStatus,
        postbackStatus: chain.postbackStatus,
        revenue: chain.revenueUsd,
        kind: interaction,
        result: primaryResult || '-',
      }
    })
    .sort((a, b) => b.timestamp - a.timestamp)
}

export function buildFilterOptions(rows = []) {
  const list = Array.isArray(rows) ? rows : []
  const interactions = new Set()
  const results = new Set()
  const placements = new Set()

  list.forEach((row) => {
    const interaction = cleanText(row.kind)
    const result = cleanText(row.result)
    const placement = cleanText(row.placementId)
    if (interaction && interaction !== '-') interactions.add(interaction)
    if (result && result !== '-') results.add(result)
    if (placement && placement !== '-') placements.add(placement)
  })

  return {
    interactions: ['ALL', ...Array.from(interactions).sort()],
    results: ['ALL', ...Array.from(results).sort()],
    placements: ['ALL', ...Array.from(placements).sort()],
  }
}
