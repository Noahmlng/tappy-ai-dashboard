import { expect, test } from '@playwright/test'

function createDashboardSnapshot(placements) {
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
      { day: '2026-02-20', impressions: 100, clicks: 8, revenueUsd: 1.2 },
      { day: '2026-02-21', impressions: 130, clicks: 10, revenueUsd: 1.5 },
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
      byAccount: [
        { accountId: 'org_smoke', requests: 1800, settledConversions: 21, settledRevenueUsd: 42.12, cpa: 2.01 },
      ],
      byApp: [
        { accountId: 'org_smoke', appId: 'app_smoke', requests: 1800, settledConversions: 21, settledRevenueUsd: 42.12, cpa: 2.01 },
      ],
      byPlacement: [
        { accountId: 'org_smoke', appId: 'app_smoke', placementId: 'chat_from_answer_v1', layer: 'runtime', requests: 1800, settledConversions: 21, settledRevenueUsd: 42.12, ctr: 0.07, fillRate: 0.66, cpa: 2.01 },
      ],
    },
    placements,
    placementAuditLogs: [],
    networkHealth: {},
    networkHealthSummary: { totalNetworks: 0, healthy: 0, degraded: 0, open: 0 },
    networkFlowStats: {
      totalRuntimeEvaluations: 0,
      degradedRuntimeEvaluations: 0,
      resilientServes: 0,
      servedWithNetworkErrors: 0,
      noFillWithNetworkErrors: 0,
      runtimeErrors: 0,
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
    controlPlaneApps: [
      { accountId: 'org_smoke', appId: 'app_smoke', displayName: 'Smoke App' },
    ],
    scope: {
      accountId: 'org_smoke',
      appId: 'app_smoke',
    },
  }
}

test.describe('dashboard smoke flow', () => {
  test.beforeEach(async ({ page }) => {
    const rotateKeyPath = /^\/api\/v1\/public\/credentials\/keys\/[^/]+\/rotate$/
    const revokeKeyPath = /^\/api\/v1\/public\/credentials\/keys\/[^/]+\/revoke$/
    const placementUpdatePath = /^\/api\/v1\/dashboard\/placements\/[^/]+$/

    let loggedIn = false
    let keys = [
      {
        keyId: 'key_1',
        appId: 'app_smoke',
        accountId: 'org_smoke',
        name: 'runtime-prod',
        environment: 'prod',
        status: 'active',
        maskedKey: 'sk_live_****',
        createdAt: '2026-02-25T10:00:00.000Z',
      },
    ]
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

        await json(200, {
          user: { email: 'smoke@example.com', accountId: 'org_smoke', appId: 'app_smoke' },
          session: { id: 'sess_1' },
          scope: { accountId: 'org_smoke', appId: 'app_smoke' },
        })
        return
      }

      if (pathname === '/api/v1/public/dashboard/login' && method === 'POST') {
        loggedIn = true
        await json(200, {
          user: { email: 'smoke@example.com', accountId: 'org_smoke', appId: 'app_smoke' },
          session: { id: 'sess_1' },
          scope: { accountId: 'org_smoke', appId: 'app_smoke' },
        }, {
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

      if (pathname === '/api/v1/dashboard/state' && method === 'GET') {
        await json(200, createDashboardSnapshot(placements))
        return
      }

      if (pathname === '/api/v1/public/credentials/keys' && method === 'GET') {
        await json(200, { keys })
        return
      }

      if (pathname === '/api/v1/public/credentials/keys' && method === 'POST') {
        const next = {
          keyId: 'key_new',
          appId: 'app_smoke',
          accountId: 'org_smoke',
          name: 'runtime-prod',
          environment: 'prod',
          status: 'active',
          maskedKey: 'sk_live_new****',
          createdAt: '2026-02-25T10:01:00.000Z',
        }
        keys = [next, ...keys]
        await json(200, { key: next, secret: 'sk_live_new_secret' })
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

  test('login -> home -> api keys -> config -> logs -> logout', async ({ page }) => {
    await page.goto('/login')

    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()
    await page.getByLabel('Email').fill('smoke@example.com')
    await page.getByLabel('Password').fill('smoke-password')
    await page.getByRole('button', { name: 'Sign In' }).click()

    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByRole('heading', { name: 'Revenue' })).toBeVisible()

    await page.locator('aside .nav-link[href=\"/api-keys\"]').first().click()
    await expect(page).toHaveURL(/\/api-keys$/)
    await expect(page.getByRole('heading', { name: 'Key', exact: true })).toBeVisible()

    await page.locator('aside .nav-link[href=\"/config\"]').first().click()
    await expect(page).toHaveURL(/\/config$/)
    await expect(page.getByRole('heading', { name: 'Placement', exact: true })).toBeVisible()

    await page.locator('aside .nav-link[href=\"/logs\"]').first().click()
    await expect(page).toHaveURL(/\/logs$/)
    await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible()

    const hasAuthTokenInStorage = await page.evaluate(() => (
      Object.keys(window.localStorage).some((key) => key.includes('auth'))
    ))
    expect(hasAuthTokenInStorage).toBe(false)

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()
  })
})
