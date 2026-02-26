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
  - `GET /api/v1/public/sdk/bootstrap`
  - `POST /api/v2/bid` (normalized to include `landingUrl`)

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

## Onboarding Contract

- SDK only requires `MEDIATION_API_KEY`.
- Customer runtime domain must be verified and bound before onboarding is unlocked.
- Verify-and-bind success requires:
  - DNS resolvable + CNAME to runtime gateway
  - TLS handshake success
  - Auth success on `POST /api/v2/bid`
  - Bid response includes a usable `landingUrl` (direct field or normalized from `url/link/message`)

## Auth Model

Dashboard auth uses cookie sessions.

- `dash_session`: HttpOnly + Secure + SameSite=Lax + Path=/
- `dash_csrf`: Secure + SameSite=Lax
- Browser write requests send `x-csrf-token` from `dash_csrf`

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
