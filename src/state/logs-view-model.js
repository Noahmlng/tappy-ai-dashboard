function cleanText(value) {
  return String(value || '').trim()
}

function firstText(source, keys = []) {
  for (const key of keys) {
    const normalized = cleanText(source?.[key])
    if (normalized) return normalized
  }
  return ''
}

function firstNumber(source, keys = []) {
  for (const key of keys) {
    const raw = source?.[key]
    const numeric = Number(raw)
    if (Number.isFinite(numeric)) return numeric
  }
  return 0
}

function toTimestamp(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = cleanText(value)
  if (!text) return fallback
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return parsed
  return fallback
}

function buildDetail(source = {}, keys = []) {
  const text = firstText(source, keys)
  if (text) return text

  const code = firstText(source, ['code', 'errorCode', 'reasonCode'])
  if (code) return code

  return '-'
}

function normalizeDecisionLog(row = {}, index = 0) {
  const timestamp = toTimestamp(
    firstText(row, ['createdAt', 'timestamp', 'occurredAt', 'eventAt']),
    Date.now() - index,
  )
  return {
    id: firstText(row, ['id', 'requestId', 'traceId']) || `decision_${index}`,
    timestamp,
    timeLabel: firstText(row, ['createdAt', 'occurredAt', 'eventAt']) || '-',
    traceId: firstText(row, ['requestId', 'traceId', 'id']) || '-',
    source: 'decision',
    stage: firstText(row, ['stage', 'event', 'action']) || 'decision',
    result: firstText(row, ['result', 'status', 'outcome']) || '-',
    placementId: firstText(row, ['placementId', 'placement', 'placement_id']) || '-',
    detail: buildDetail(row, ['reasonDetail', 'reason', 'message']),
  }
}

function normalizeRuntimeFlowLog(row = {}, index = 0) {
  const timestamp = toTimestamp(
    firstText(row, ['createdAt', 'timestamp', 'occurredAt', 'eventAt']),
    Date.now() - index,
  )
  return {
    id: firstText(row, ['id', 'requestId', 'traceId']) || `runtime_flow_${index}`,
    timestamp,
    timeLabel: firstText(row, ['createdAt', 'occurredAt', 'eventAt']) || '-',
    traceId: firstText(row, ['traceId', 'requestId', 'id']) || '-',
    source: 'runtime_flow',
    stage: firstText(row, ['stage', 'event', 'step']) || 'runtime',
    result: firstText(row, ['status', 'result', 'outcome']) || '-',
    placementId: firstText(row, ['placementId', 'placement', 'placement_id']) || '-',
    detail: buildDetail(row, ['message', 'error', 'reasonDetail', 'reason']),
  }
}

function normalizePlacementAuditLog(row = {}, index = 0) {
  const timestamp = toTimestamp(
    firstText(row, ['createdAt', 'timestamp', 'occurredAt', 'eventAt']),
    Date.now() - index,
  )

  const changedCount = firstNumber(row, ['changedCount', 'changed_fields_count'])
  const fallbackDetail = changedCount > 0 ? `changed_fields=${changedCount}` : '-'
  const detail = buildDetail(row, ['message', 'reasonDetail', 'reason'])

  return {
    id: firstText(row, ['id', 'auditId']) || `placement_audit_${index}`,
    timestamp,
    timeLabel: firstText(row, ['createdAt', 'occurredAt', 'eventAt']) || '-',
    traceId: firstText(row, ['requestId', 'traceId', 'id', 'auditId']) || '-',
    source: 'placement_audit',
    stage: firstText(row, ['action', 'event', 'field']) || 'placement_update',
    result: firstText(row, ['status', 'result']) || '-',
    placementId: firstText(row, ['placementId', 'placement', 'placement_id']) || '-',
    detail: detail === '-' ? fallbackDetail : detail,
  }
}

export function buildUnifiedLogs(input = {}) {
  const decisionLogs = Array.isArray(input.decisionLogs) ? input.decisionLogs : []
  const networkFlowLogs = Array.isArray(input.networkFlowLogs) ? input.networkFlowLogs : []
  const placementAuditLogs = Array.isArray(input.placementAuditLogs) ? input.placementAuditLogs : []

  const mapped = [
    ...decisionLogs.map((row, index) => normalizeDecisionLog(row, index)),
    ...networkFlowLogs.map((row, index) => normalizeRuntimeFlowLog(row, index)),
    ...placementAuditLogs.map((row, index) => normalizePlacementAuditLog(row, index)),
  ]

  return mapped.sort((a, b) => b.timestamp - a.timestamp)
}

export function buildFilterOptions(rows = []) {
  const normalizedRows = Array.isArray(rows) ? rows : []

  const sources = new Set()
  const results = new Set()
  const placements = new Set()

  for (const row of normalizedRows) {
    const source = cleanText(row.source)
    const result = cleanText(row.result)
    const placement = cleanText(row.placementId)
    if (source && source !== '-') sources.add(source)
    if (result && result !== '-') results.add(result)
    if (placement && placement !== '-') placements.add(placement)
  }

  return {
    sources: ['ALL', ...Array.from(sources).sort()],
    results: ['ALL', ...Array.from(results).sort()],
    placements: ['ALL', ...Array.from(placements).sort()],
  }
}
