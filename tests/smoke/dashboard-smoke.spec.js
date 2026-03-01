import { expect, test } from '@playwright/test'

function createDashboardSnapshot(placements, appId) {
  const scopedAppId = appId || 'app_smoke'
  return {
    placementConfigVersion: 1,
    metricsSummary: {
      revenueUsd: 12.34,
      impressions: 1200,
      clicks: 82,
      ctr: 0.068,
      ecpm: 9.8,
      fillRate: 0.71,
    },
    metricsByDay: [
      { day: '2026-02-20', requests: 100, settledConversions: 8, revenueUsd: 1.2 },
      { day: '2026-02-21', requests: 130, settledConversions: 10, revenueUsd: 1.5 },
    ],
    settlementAggregates: {
      settlementModel: 'CPA',
      currency: 'USD',
      totals: {
        requests: 1800,
        served: 1200,
        impressions: 1100,
        clicks: 78,
        settledConversions: 21,
        settledRevenueUsd: 42.12,
        ctr: 0.07,
        fillRate: 0.66,
        ecpm: 8.9,
        cpa: 2.01,
      },
      byAccount: [],
      byApp: [],
      byPlacement: [],
    },
    placements,
    placementAuditLogs: [
      {
        id: 'audit_1',
        requestId: 'req_1',
        createdAt: '2026-02-25T10:02:00.000Z',
        action: 'placement_toggle',
        status: 'ok',
        placementId: 'chat_from_answer_v1',
        changedCount: 1,
      },
    ],
    networkHealth: {},
    networkHealthSummary: { totalNetworks: 0, healthy: 0, degraded: 0, open: 0 },
    networkFlowStats: {
      totalRuntimeEvaluations: 100,
      degradedRuntimeEvaluations: 0,
      resilientServes: 0,
      servedWithNetworkErrors: 0,
      noFillWithNetworkErrors: 0,
      runtimeErrors: 5,
      circuitOpenEvaluations: 0,
    },
    networkFlowLogs: [],
    decisionLogs: [
      {
        id: 'log_1',
        requestId: 'req_1',
        createdAt: '2026-02-25T10:00:00.000Z',
        placementId: 'chat_from_answer_v1',
        result: 'served',
        reason: 'eligible',
      },
    ],
    eventLogs: [
      {
        id: 'event_1',
        requestId: 'req_1',
        createdAt: '2026-02-25T10:04:00.000Z',
        eventType: 'sdk_event',
        kind: 'click',
        event: 'click',
        result: 'recorded',
        placementId: 'chat_from_answer_v1',
        targetUrl: 'https://ads.example.com/c/req_1',
        reasonCode: 'click_recorded',
        revenueUsd: 0.5,
      },
      {
        id: 'event_2',
        requestId: 'req_1',
        createdAt: '2026-02-25T10:05:00.000Z',
        eventType: 'postback',
        postbackStatus: 'success',
        placementId: 'chat_from_answer_v1',
        revenueUsd: 1.2,
      },
    ],
    controlPlaneApps: [
      { accountId: 'org_smoke', appId: scopedAppId, displayName: 'Smoke App' },
    ],
    scope: {
      accountId: 'org_smoke',
      appId: scopedAppId,
    },
  }
}

test.describe('dashboard smoke flow', () => {
  test.beforeEach(async ({ page }) => {
    const rotateKeyPath = /^\/api\/v1\/public\/credentials\/keys\/[^/]+\/rotate$/
    const revokeKeyPath = /^\/api\/v1\/public\/credentials\/keys\/[^/]+\/revoke$/
    const placementUpdatePath = /^\/api\/v1\/dashboard\/placements\/[^/]+$/

    let loggedIn = false
    let scopedAppId = ''
    let keys = []
    let placements = [
      {
        placementId: 'chat_from_answer_v1',
        enabled: true,
        maxFanout: 3,
        globalTimeoutMs: 1200,
        surface: 'chat',
        bidders: ['network_a', 'network_b'],
        frequencyCap: { perMinute: 2, perHour: 10 },
        trigger: { intentThreshold: 0.7, cooldownMs: 1000 },
      },
    ]

    const authPayload = () => ({
      user: { email: 'smoke@example.com', accountId: 'org_smoke', appId: scopedAppId },
      session: { id: 'sess_1' },
      scope: { accountId: 'org_smoke', appId: scopedAppId },
      onboarding: {
        status: 'verified',
        verifiedAt: '2026-02-25T10:00:00.000Z',
      },
    })

    await page.route('**/api/v1/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const pathname = url.pathname
      const method = request.method().toUpperCase()

      const json = (status, payload, headers = {}) => route.fulfill({
        status,
        contentType: 'application/json; charset=utf-8',
        headers,
        body: JSON.stringify(payload),
      })

      if (pathname === '/api/v1/public/dashboard/me' && method === 'GET') {
        if (!loggedIn) {
          await json(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
          return
        }
        await json(200, authPayload())
        return
      }

      if (pathname === '/api/v1/public/dashboard/login' && method === 'POST') {
        loggedIn = true
        await json(200, authPayload(), {
          'set-cookie': 'dash_session=sess_1; Path=/; HttpOnly; Secure; SameSite=Lax',
        })
        return
      }

      if (pathname === '/api/v1/public/dashboard/register' && method === 'POST') {
        loggedIn = true
        await json(200, authPayload(), {
          'set-cookie': 'dash_session=sess_1; Path=/; HttpOnly; Secure; SameSite=Lax',
        })
        return
      }

      if (pathname === '/api/v1/public/dashboard/logout' && method === 'POST') {
        loggedIn = false
        await json(200, { ok: true }, {
          'set-cookie': 'dash_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
        })
        return
      }

      if (pathname === '/api/v1/public/quick-start/verify' && method === 'POST') {
        await json(200, {
          ok: true,
          status: 'ready',
          requestId: 'verify_req_1',
          evidence: { inventory: { ready: true } },
        })
        return
      }

      if (pathname === '/api/v1/dashboard/state' && method === 'GET') {
        await json(200, createDashboardSnapshot(placements, scopedAppId || 'app_smoke'))
        return
      }

      if (pathname === '/api/v1/public/credentials/keys' && method === 'GET') {
        await json(200, { keys })
        return
      }

      if (pathname === '/api/v1/public/credentials/keys' && method === 'POST') {
        scopedAppId = scopedAppId || 'app_smoke'
        const next = {
          keyId: `key_${keys.length + 1}`,
          appId: scopedAppId,
          accountId: 'org_smoke',
          name: 'runtime-prod',
          environment: 'prod',
          status: 'active',
          maskedKey: 'sk_live_new****',
          createdAt: '2026-02-25T10:01:00.000Z',
        }
        keys = [next, ...keys]
        await json(200, {
          key: next,
          secret: 'sk_live_new_secret',
          scope: {
            accountId: 'org_smoke',
            appId: scopedAppId,
          },
        })
        return
      }

      if (rotateKeyPath.test(pathname) && method === 'POST') {
        const targetId = pathname.split('/')[6]
        const rotated = {
          ...keys.find((row) => row.keyId === targetId),
          keyId: targetId,
          status: 'active',
          maskedKey: 'sk_live_rotated****',
        }
        keys = keys.map((row) => (row.keyId === targetId ? rotated : row))
        await json(200, { key: rotated, secret: 'sk_live_rotated_secret' })
        return
      }

      if (revokeKeyPath.test(pathname) && method === 'POST') {
        const targetId = pathname.split('/')[6]
        const revoked = {
          ...keys.find((row) => row.keyId === targetId),
          keyId: targetId,
          status: 'revoked',
        }
        keys = keys.map((row) => (row.keyId === targetId ? revoked : row))
        await json(200, { key: revoked })
        return
      }

      if (placementUpdatePath.test(pathname) && method === 'PUT') {
        const targetId = decodeURIComponent(pathname.split('/').pop() || '')
        const patch = JSON.parse(request.postData() || '{}')
        const idx = placements.findIndex((row) => row.placementId === targetId)
        if (idx >= 0) {
          placements[idx] = {
            ...placements[idx],
            ...patch,
            frequencyCap: {
              ...(placements[idx].frequencyCap || {}),
              ...(patch.frequencyCap || {}),
            },
            trigger: {
              ...(placements[idx].trigger || {}),
              ...(patch.trigger || {}),
            },
          }
          await json(200, { placement: placements[idx] })
          return
        }
        await json(404, { error: { code: 'NOT_FOUND', message: 'Placement not found' } })
        return
      }

      await json(404, { error: { code: 'NOT_FOUND', message: `${method} ${pathname}` } })
    })
  })

  test('login -> minimal nav -> settings actions -> click-chain logs', async ({ page }) => {
    await page.goto('/login')

    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()
    await page.getByLabel('Email').fill('smoke@example.com')
    await page.getByLabel('Password').fill('smoke-password')
    await page.getByRole('button', { name: 'Sign In' }).click()

    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
    await expect(page.locator('aside .nav-link')).toHaveCount(3)

    await expect(page.getByText('Revenue')).toBeVisible()
    await expect(page.getByText('Requests')).toBeVisible()
    await expect(page.getByText('Fill Rate')).toBeVisible()
    await expect(page.getByText('Errors')).toBeVisible()

    await page.locator('aside .nav-link[href="/settings"]').first().click()
    await expect(page).toHaveURL(/\/settings(\?section=integration)?$/)
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'API Keys' }).click()
    await expect(page).toHaveURL(/\/settings\?section=keys$/)
    await page.getByRole('button', { name: 'Generate Key' }).click()
    await expect(page.getByText('Secret (once):')).toBeVisible()

    await page.getByRole('button', { name: 'Placement' }).click()
    await expect(page).toHaveURL(/\/settings\?section=placement$/)
    const thresholdInput = page.getByLabel('Intent Threshold').first()
    await expect(thresholdInput).toHaveValue('0.7')
    await thresholdInput.fill('0.82')
    await thresholdInput.press('Tab')
    await expect(thresholdInput).toHaveValue('0.82')

    await page.locator('aside .nav-link[href="/logs"]').first().click()
    await expect(page).toHaveURL(/\/logs$/)
    await expect(page.getByRole('heading', { name: 'Interaction Chains', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'https://ads.example.com/c/req_1' })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'success' })).toBeVisible()

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login$/)
  })

  test('legacy route redirects to login with new target', async ({ page }) => {
    await page.goto('/usage')
    await expect(page).toHaveURL(/\/login\?redirect=\/home$/)
  })
})
