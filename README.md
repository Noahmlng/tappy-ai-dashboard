# Tappy AI Dashboard

A control-plane dashboard for revenue, usage, API keys, placement config, and decision logs.

## Core Pages

- Onboarding
- Revenue
- Usage
- API Keys
- Placement
- Logs

## Local Run

```bash
npm install
npm run dev
```

The SPA always calls same-origin `/api/*`.

- For local development, `vite` proxies `/api` to `MEDIATION_CONTROL_PLANE_API_PROXY_TARGET`.
- For Vercel/production, `/api/*` is handled by `api/[...path].js` and forwarded to `MEDIATION_CONTROL_PLANE_API_BASE_URL`.
- Runtime onboarding now uses:
  - `POST /api/v1/public/runtime-domain/verify-and-bind`
  - `POST /api/v1/public/runtime-domain/probe`
  - `GET /api/v1/public/sdk/bootstrap`
  - `POST /api/v2/bid` (normalized to include `landingUrl`)
  - `POST /api/ad/bid` (returns `filled` with structured no-fill diagnostics)

## Build

```bash
npm run build
```

## Quality Gates

```bash
npm run check:env
npm run check:dead-code
npm run lint
npm test
npm run test:smoke
npm run build
```

## Environment Variables

- `MEDIATION_CONTROL_PLANE_API_BASE_URL` (required in production)
  Example: `https://<your-control-plane-origin>/api`
- `MEDIATION_CONTROL_PLANE_API_PROXY_TARGET` (optional, local dev only)
  Default: `http://127.0.0.1:3100`
- `MEDIATION_RUNTIME_GATEWAY_HOST` (optional)
  Default: `runtime-gateway.tappy.ai`
- `MEDIATION_RUNTIME_REQUIRE_GATEWAY_CNAME` (optional)
  Default: `0` (disabled). Set to `1` to enforce CNAME-to-gateway as a hard requirement.
- `MEDIATION_RUNTIME_ALLOW_MANAGED_FALLBACK` (optional)
  Default: `1` (enabled). Set to `0` to disable managed runtime fallback/default routing.
- `MEDIATION_MANAGED_RUNTIME_BASE_URL` (optional)
  Explicit managed runtime base URL for fallback/default mode. If unset, proxy auto-derives from `MEDIATION_CONTROL_PLANE_API_BASE_URL`.

## Onboarding Contract

- SDK/backend integration requires `MEDIATION_API_KEY`.
- Hosted bootstrap origin is fixed at `https://tappy-ai-dashboard.vercel.app/api/v1/public/sdk/bootstrap` in the integration snippet, so no extra bootstrap env is required in normal onboarding.
- `sdk/bootstrap` prefers a routable runtime: `customer(verified)` -> `managed_fallback(pending/failed)` -> `managed_default(unbound)`.
- `verify-and-bind` now returns `status: verified | pending | failed`.
- `pending` means domain is already bound (DNS + TLS passed), but live probe is still failing.
- When bind status is `pending`, `sdk/bootstrap` can return `runtimeSource=managed_fallback` and a managed `runtimeBaseUrl` so SDK integration still works while custom runtime is being fixed.
- When no binding exists, `sdk/bootstrap` can return `runtimeSource=managed_default` with `bindStatus=unbound` so key-only integration still works.
- For `bindStatus=unbound`, bootstrap still returns a stable `tenantId` (derived from API key hash) to avoid empty-tenant integrations.
- `/api/ad/bid` always returns `filled`; when `filled=false`, payload includes `reasonCode`, `reasonMessage`, `nextAction`, and `traceId`.
- Dashboard navigation unlocks for both `pending` and `verified`, while a top warning banner remains for `pending`.
- Onboarding is considered complete only when `status=verified`.
- Runtime probe uses granular codes (for example `EGRESS_BLOCKED`, `ENDPOINT_404`, `AUTH_401_403`, `LANDING_URL_MISSING`) and returns actionable `nextActions`.
- If `MEDIATION_RUNTIME_REQUIRE_GATEWAY_CNAME=1`, verify-and-bind also requires CNAME to the configured runtime gateway.

## Auth Model

Dashboard auth uses cookie sessions.

- `dash_session`: HttpOnly + Secure + SameSite=Lax + Path=/
- `dash_csrf`: Secure + SameSite=Lax
- Browser write requests send `x-csrf-token` from `dash_csrf`
- Client request strategy:
  - Dashboard APIs use cookie + CSRF by default
  - Runtime onboarding APIs require explicit `Authorization: Bearer <MEDIATION_API_KEY>`
  - For legacy upstream compatibility, dashboard requests may retry once with stored bearer token only after 401/403

## Deploy (Vercel)

1. Import this repo in Vercel.
2. Set `MEDIATION_CONTROL_PLANE_API_BASE_URL` for Preview and Production.
3. Add GitHub repository secrets:
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`
   - `NODE_AUTH_TOKEN` (optional, only if private npm packages are required)
4. PRs deploy Preview; pushes to `main` deploy Production.

## Ongoing Hygiene

- `dependabot.yml` opens weekly npm/actions update PRs.
- `hygiene-weekly.yml` runs weekly safety checks:
  - env contract
  - dead code scan
  - lint + unit + smoke
  - build regression
  - production dependency audit
