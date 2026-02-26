# Tappy AI Dashboard

A control-plane dashboard for revenue, usage, API keys, placement config, and decision logs.

## Core Pages

- Revenue
- Usage
- Quick Start
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

## Build

```bash
npm run build
```

## Quality Gates

```bash
npm run check:env
npm run lint
npm test
npm run test:smoke
npm run build
```

## Environment Variables

- `MEDIATION_CONTROL_PLANE_API_BASE_URL` (required in production)
  Example: `https://control-plane.example.com/api`
- `MEDIATION_CONTROL_PLANE_API_PROXY_TARGET` (optional, local dev only)
  Default: `http://127.0.0.1:3100`

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
