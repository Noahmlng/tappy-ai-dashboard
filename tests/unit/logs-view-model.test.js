import { describe, expect, it } from 'vitest'

import { buildFilterOptions, buildUnifiedLogs } from '../../src/state/logs-view-model'

describe('logs view model', () => {
  it('aggregates request chains with click link priority, postback status, and max revenue', () => {
    const rows = buildUnifiedLogs({
      eventLogs: [
        {
          id: 'evt_click_1',
          requestId: 'req_1',
          createdAt: '2026-02-25T10:00:00.000Z',
          eventType: 'sdk_event',
          kind: 'click',
          result: 'recorded',
          placementId: 'chat_from_answer_v1',
          clickUrl: 'https://ads.example.com/click/1',
          revenueUsd: 0.3,
        },
        {
          id: 'evt_click_2',
          requestId: 'req_1',
          createdAt: '2026-02-25T10:01:00.000Z',
          eventType: 'redirect_click',
          status: 'redirected',
          placementId: 'chat_from_answer_v1',
          targetUrl: 'https://ads.example.com/target/1',
          revenueUsd: 0.5,
        },
        {
          id: 'evt_postback_1',
          requestId: 'req_1',
          createdAt: '2026-02-25T10:02:00.000Z',
          eventType: 'postback',
          postbackStatus: 'success',
          placementId: 'chat_from_answer_v1',
          revenueUsd: 1.2,
        },
      ],
      decisionLogs: [
        {
          id: 'dec_1',
          requestId: 'req_1',
          createdAt: '2026-02-25T09:59:00.000Z',
          result: 'served',
          placementId: 'chat_from_answer_v1',
          reason: 'eligible',
        },
      ],
      placementAuditLogs: [],
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestId: 'req_1',
      placementId: 'chat_from_answer_v1',
      clickedLink: 'https://ads.example.com/target/1',
      clickStatus: 'redirected',
      postbackStatus: 'success',
      revenue: 1.2,
      kind: 'click',
      result: 'redirected',
    })
  })

  it('builds minimal filter options from chain rows', () => {
    const options = buildFilterOptions([
      { kind: 'click', result: 'recorded', placementId: 'p1' },
      { kind: 'postback', result: 'success', placementId: 'p1' },
      { kind: 'decision', result: 'served', placementId: 'p2' },
      { kind: '-', result: '-', placementId: '-' },
    ])

    expect(options.interactions).toEqual(['ALL', 'click', 'decision', 'postback'])
    expect(options.results).toEqual(['ALL', 'recorded', 'served', 'success'])
    expect(options.placements).toEqual(['ALL', 'p1', 'p2'])
  })

  it('handles missing requestId by keeping fallback rows', () => {
    const rows = buildUnifiedLogs({
      eventLogs: [
        {
          id: 'evt_no_req_1',
          createdAt: '2026-02-25T10:05:00.000Z',
          kind: 'impression',
          placementId: 'p3',
          result: 'recorded',
        },
      ],
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestId: '-',
      placementId: 'p3',
      kind: 'impression',
    })
  })
})
