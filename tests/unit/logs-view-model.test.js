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
      eventLogs: [
        {
          id: 'e_1',
          requestId: 'req_click',
          createdAt: '2026-02-25T10:04:00.000Z',
          eventType: 'sdk_event',
          kind: 'click',
          result: 'recorded',
          placementId: 'p3',
          targetUrl: 'https://ads.example.com/c/1',
          reasonCode: 'click_recorded',
        },
      ],
    })

    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.source)).toEqual(['runtime_event', 'runtime_flow', 'placement_audit', 'decision'])
    expect(rows[0]).toMatchObject({
      kind: 'click',
      linkUrl: 'https://ads.example.com/c/1',
      detail: 'click_recorded',
    })
    expect(rows[0]).toMatchObject({
      traceId: 'req_click',
    })
    expect(rows[1]).toMatchObject({
      traceId: 'trace_runtime',
      stage: 'bid_request',
      detail: 'runtime ok',
    })
    expect(rows[2]).toMatchObject({
      result: 'ok',
      detail: 'changed_fields=2',
    })
    expect(rows[3]).toMatchObject({
      result: 'served',
      detail: 'eligible',
    })
  })

  it('builds filter options from unified rows with ALL fallback', () => {
    const options = buildFilterOptions([
      { source: 'decision', result: 'served', placementId: 'p1' },
      { source: 'runtime_flow', result: 'error', placementId: 'p2' },
      { source: 'runtime_event', result: 'recorded', placementId: 'p3' },
      { source: 'placement_audit', result: '-', placementId: '-' },
    ])

    expect(options.sources).toEqual(['ALL', 'decision', 'placement_audit', 'runtime_event', 'runtime_flow'])
    expect(options.results).toEqual(['ALL', 'error', 'recorded', 'served'])
    expect(options.placements).toEqual(['ALL', 'p1', 'p2', 'p3'])
  })
})
