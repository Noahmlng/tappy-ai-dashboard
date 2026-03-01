import { describe, expect, it } from 'vitest'

import { LEGACY_ROUTE_REDIRECTS, ROOT_REDIRECT } from '../../src/router/route-redirects'

describe('router legacy redirects', () => {
  it('redirects legacy routes to minimal IA destinations', () => {
    expect(LEGACY_ROUTE_REDIRECTS['/usage']).toBe('/home')
    expect(LEGACY_ROUTE_REDIRECTS['/api-keys']).toBe('/settings?section=keys')
    expect(LEGACY_ROUTE_REDIRECTS['/config']).toBe('/settings?section=placement')
    expect(LEGACY_ROUTE_REDIRECTS['/onboarding']).toBe('/settings?section=integration')
    expect(LEGACY_ROUTE_REDIRECTS['/quick-start']).toBe('/settings?section=integration')
  })

  it('redirects root to /home', () => {
    expect(ROOT_REDIRECT).toBe('/home')
  })
})
