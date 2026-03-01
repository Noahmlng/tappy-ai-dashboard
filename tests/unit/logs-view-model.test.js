import { describe, expect, it } from 'vitest'

import { buildFilterOptions, buildUnifiedLogs } from '../../src/state/logs-view-model'

describe('logs view model', () => {
  it('merges decision/runtime/audit logs and sorts by time desc', () => {
    const rows = buildUnifiedLogs({
      decisionLogs: [
        {
          id: 'd_1',
          requestId: 'req_decision',
          createdAt: '2026-02-25T10:00:00.000Z',
          result: 'served',
          placementId: 'p1',
          reason: 'eligible',
        },
      ],
      networkFlowLogs: [
        {
          id: 'n_1',
          traceId: 'trace_runtime',
          createdAt: '2026-02-25T10:03:00.000Z',
          stage: 'bid_request',
          status: 'success',
          placementId: 'p2',
          message: 'runtime ok',
        },
      ],
      placementAuditLogs: [
        {
          id: 'a_1',
          requestId: 'req_audit',
          createdAt: '2026-02-25T10:01:00.000Z',
          action: 'placement_toggle',
          status: 'ok',
          placementId: 'p1',
          changedCount: 2,
        },
      ],
    })

    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.source)).toEqual(['runtime_flow', 'placement_audit', 'decision'])
    expect(rows[0]).toMatchObject({
      traceId: 'trace_runtime',
      stage: 'bid_request',
      detail: 'runtime ok',
    })
    expect(rows[1]).toMatchObject({
      result: 'ok',
      detail: 'changed_fields=2',
    })
    expect(rows[2]).toMatchObject({
      result: 'served',
      detail: 'eligible',
    })
  })

  it('builds filter options from unified rows with ALL fallback', () => {
    const options = buildFilterOptions([
      { source: 'decision', result: 'served', placementId: 'p1' },
      { source: 'runtime_flow', result: 'error', placementId: 'p2' },
      { source: 'placement_audit', result: '-', placementId: '-' },
    ])

    expect(options.sources).toEqual(['ALL', 'decision', 'placement_audit', 'runtime_flow'])
    expect(options.results).toEqual(['ALL', 'error', 'served'])
    expect(options.placements).toEqual(['ALL', 'p1', 'p2'])
  })
})
