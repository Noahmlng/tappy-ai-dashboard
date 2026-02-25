# Simulator: Developer Dashboard

A simulation console for SDK integrators to manage placements, trigger params, and revenue analytics.

## Core pages

- Overview: revenue and performance KPI snapshots
- Placements: placement enable/priority/frequency controls
- Triggers: intent/cooldown/revenue threshold controls
- Decision Logs: trigger results and non-trigger reasons

## Run

```bash
npm install
npm run dev
```

By default, Dashboard reads and writes through `/api` (expected to proxy to local simulator gateway).
Default local gateway target: `http://127.0.0.1:3100`.

## Build

```bash
npm run build
```

## Contracts Package

Dashboard consumes shared contracts from:

- `@ai-network/mediation-sdk-contracts`

Current local development uses a file dependency pointing to:

- `../chat-ads-main/packages/mediation-sdk-contracts`

After contracts are published to GitHub Packages, switch this dependency to a semver version.

## Environment Variables

- Required for production:
  - `VITE_MEDIATION_CONTROL_PLANE_API_BASE_URL` (example: `https://control-plane.example.com/api`)
- Optional for split runtime domain:
  - `VITE_MEDIATION_RUNTIME_API_BASE_URL` (example: `https://runtime.example.com/api`)
- Local development:
  - `MEDIATION_CONTROL_PLANE_API_PROXY_TARGET` (default `http://127.0.0.1:3100`)
  - `VITE_MEDIATION_CONTROL_PLANE_API_BASE_URL` can stay `/api` when using local proxy.
- Optional internal flags (dev-only):
  - `VITE_DASHBOARD_V1_MINIMAL`
  - `VITE_ENABLE_INTERNAL_RESET`

## Production Deploy (Vercel)

1. Create a Vercel project with root directory `projects/simulator-dashboard`.
2. Set `VITE_MEDIATION_CONTROL_PLANE_API_BASE_URL` to the deployed control-plane API URL plus `/api`.
3. If runtime is split, set `VITE_MEDIATION_RUNTIME_API_BASE_URL` to runtime API URL plus `/api`.
4. Deploy with `vercel deploy projects/simulator-dashboard -y`.
5. Promote with `vercel deploy --prod -y` after smoke tests pass.

This dashboard only depends on Mediation API endpoints and does not require chatbot deployment.
