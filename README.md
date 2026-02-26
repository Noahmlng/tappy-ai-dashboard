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

- `GET/POST /api/v1/*` (control-plane routes) are proxied to `MEDIATION_CONTROL_PLANE_API_BASE_URL`.
- `POST /api/v2/bid` is proxied to `MEDIATION_RUNTIME_API_BASE_URL` when set, otherwise falls back to `MEDIATION_CONTROL_PLANE_API_BASE_URL`.
- Removed routes now return `410`:
  - `GET /api/v1/public/sdk/bootstrap`
  - `POST /api/v1/public/runtime-domain/verify-and-bind`
  - `POST /api/v1/public/runtime-domain/probe`
  - `POST /api/ad/bid`

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
  - Example: `https://<your-control-plane-origin>/api`
- `MEDIATION_RUNTIME_API_BASE_URL` (optional runtime override)
  - Example: `https://<your-runtime-origin>/api`
- `MEDIATION_CONTROL_PLANE_API_PROXY_TARGET` (optional, local Vite dev only)
  - Default: `http://127.0.0.1:3100`

## MVP Onboarding Contract

- Required:
  - Generate runtime key
  - Call `POST /api/v2/bid`
- Not part of current direct integration path:
  - `sdk/bootstrap`
  - runtime bind/probe flow
  - SDK event reporting route

`No bid` with HTTP 200 is a valid business result (not an integration error).

## Auth Model

Dashboard auth uses cookie sessions.

- `dash_session`: HttpOnly + Secure + SameSite=Lax + Path=/
- `dash_csrf`: Secure + SameSite=Lax
- Browser write requests send `x-csrf-token` from `dash_csrf`
- Dashboard APIs use cookie + CSRF by default

## Deploy (Vercel)

1. Import this repo in Vercel.
2. Set `MEDIATION_CONTROL_PLANE_API_BASE_URL` for Preview and Production.
   - Optional: set `MEDIATION_RUNTIME_API_BASE_URL` only when runtime traffic must go to a different origin.
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
