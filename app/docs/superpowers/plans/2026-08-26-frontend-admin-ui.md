# Frontend/Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small React/Vite admin UI that exercises the complete backend alert and delivery workflow.

**Architecture:** A standalone `app/web` package contains a Vite React app, a centralized fetch client, route-level views, and plain CSS. The app stores a development JWT in session storage, uses the Vite `/api` proxy, and keeps state local to components without a global state framework.

**Tech Stack:** React, React Router, Vite, MapLibre GL JS, Terra Draw, OpenFreeMap, Vitest, Testing Library, plain CSS.

**Spec:** `app/docs/superpowers/specs/2026-08-26-frontend-admin-ui-design.md`

## Global Constraints

- Preserve all existing backend API contracts and tenant isolation.
- Use a development-only pasted/generated JWT; do not add production authentication.
- Keep browser dependencies limited to React/Vite, routing, mapping, and focused test tooling.
- Use `/api` through the Vite proxy for local development; allow `VITE_API_BASE_URL` override.
- Keep polygon GeoJSON standard and submit it unchanged to the backend.
- Run backend commands from `app/` and frontend commands from `app/web/`.
- Every task follows RED → GREEN → focused verification → coherent commit.

---

### Task 1: Web package and Vite foundation

**Files:**
- Create: `app/web/package.json`
- Create: `app/web/package-lock.json`
- Create: `app/web/index.html`
- Create: `app/web/vite.config.js`
- Create: `app/web/src/main.jsx`
- Create: `app/web/src/styles.css`
- Test: `app/web/src/config.test.js`

**Interfaces:**
- Produces `npm run dev`, `npm run build`, `npm test`, and `npm run lint` scripts.
- Exposes `VITE_API_BASE_URL` with default `/api` and Vite proxy target `http://localhost:3000`.

- [ ] Write a failing config test for the default API base and explicit environment override.
- [ ] Run `npm test -- --runInBand` (expected missing-package failure).
- [ ] Add the standalone package, Vite entrypoint, proxy, minimal React root, and CSS reset/layout tokens.
- [ ] Run `npm install`, focused config test, `npm run build`, and `npm run lint`.
- [ ] Commit `build: scaffold vite frontend package`.

### Task 2: Central API client and token settings

**Files:**
- Create: `app/web/src/api.js`
- Create: `app/web/src/api.test.js`
- Create: `app/web/src/components/TokenPanel.jsx`
- Create: `app/web/src/components/TokenPanel.test.jsx`

**Interfaces:**
- `createApi({ baseUrl, fetchImpl, getToken })` returns `listAlerts`, `getAlert`, `getDeliveries`, `listGroups`, and `createAlert`.
- Non-2xx responses throw `{ code, message, details, status }` while preserving backend error fields.
- Token panel reads/writes `sessionStorage` and visibly labels the token development-only.

- [ ] Test authorization headers, JSON bodies, idempotency header, and structured error conversion with injected fetch.
- [ ] Test token persistence, clear behavior, and development-only copy.
- [ ] Implement the client and panel with no direct `process.env` reads outside config.
- [ ] Run focused tests and lint.
- [ ] Commit `feat: add frontend api client and dev token settings`.

### Task 3: App shell, navigation, and shared presentation

**Files:**
- Create: `app/web/src/App.jsx`
- Create: `app/web/src/components/Header.jsx`
- Create: `app/web/src/components/StatusBadge.jsx`
- Create: `app/web/src/components/StatusBadge.test.jsx`
- Modify: `app/web/src/main.jsx`
- Modify: `app/web/src/styles.css`

**Interfaces:**
- Routes `/compose`, `/alerts`, `/alerts/:id`, and `/groups` are reachable from the header.
- `StatusBadge` renders exact backend statuses and accessible labels.

- [ ] Test route navigation and status rendering, including unknown status fallback.
- [ ] Implement the shell, token panel placement, route outlet, and responsive navigation.
- [ ] Run focused tests, lint, and build.
- [ ] Commit `feat: add frontend app shell and navigation`.

### Task 4: Groups view and reusable group loading

**Files:**
- Create: `app/web/src/hooks/useGroups.js`
- Create: `app/web/src/hooks/useGroups.test.js`
- Create: `app/web/src/views/GroupsView.jsx`
- Create: `app/web/src/views/GroupsView.test.jsx`

**Interfaces:**
- `useGroups(api)` returns `{ groups, loading, error, refresh }`.
- Groups view renders `name` and numeric `memberCount`, with loading/empty/error states.

- [ ] Test successful, empty, and failed group loads and refresh.
- [ ] Implement the hook and view using the shared API client.
- [ ] Run focused tests and lint.
- [ ] Commit `feat: add groups administration view`.

### Task 5: Compose form and polygon map editor

**Files:**
- Create: `app/web/src/components/PolygonEditor.jsx`
- Create: `app/web/src/components/PolygonEditor.test.jsx`
- Create: `app/web/src/views/ComposeView.jsx`
- Create: `app/web/src/views/ComposeView.test.jsx`
- Modify: `app/web/src/styles.css`

**Interfaces:**
- `buildAlertPayload(form)` returns the exact group/polygon alert body expected by `POST /api/v1/alerts`.
- `PolygonEditor` calls `onChange(geojson)` with a GeoJSON Polygon and supports a deterministic demo polygon preset.

- [ ] Test group and polygon serialization, required fields, channel selection, and submit lock/error rendering.
- [ ] Test polygon preset and change callback with mocked map/drawing adapters; do not require WebGL in unit tests.
- [ ] Implement form controls, MapLibre map initialization, OpenFreeMap style, Terra Draw polygon mode, and read-only GeoJSON preview.
- [ ] Submit through `createAlert`, generate an idempotency key, and display accepted id/replay state.
- [ ] Run focused tests, lint, and build.
- [ ] Commit `feat: add alert compose and polygon targeting`.

### Task 6: Alerts list and detail polling

**Files:**
- Create: `app/web/src/hooks/useAlerts.js`
- Create: `app/web/src/hooks/useAlertDetail.js`
- Create: `app/web/src/views/AlertsView.jsx`
- Create: `app/web/src/views/AlertsView.test.jsx`
- Create: `app/web/src/views/AlertDetailView.jsx`
- Create: `app/web/src/views/AlertDetailView.test.jsx`
- Modify: `app/web/src/styles.css`

**Interfaces:**
- `useAlerts(api)` returns `{ alerts, loading, error, refresh }`.
- `useAlertDetail(api, alertId, { pollMs })` returns alert, counts, deliveries, loading/error, and refresh; polling stops for terminal alert statuses.

- [ ] Test list loading/error/empty states and links to details.
- [ ] Test detail metadata, canonical count order, delivery rows, manual refresh, polling, and cleanup on unmount/terminal state.
- [ ] Implement both views and hooks with stable keys and accessible tables/statuses.
- [ ] Run focused tests, lint, and build.
- [ ] Commit `feat: add alert list and delivery detail views`.

### Task 7: Compose integration and documentation

**Files:**
- Modify: `app/docker-compose.yml`
- Create: `app/web/Dockerfile`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Create: `app/web/src/compose-config.test.js`

**Interfaces:**
- Optional Compose `web` service serves Vite on port 5173 and proxies `/api` to intake.
- README documents backend startup, token generation, frontend startup/opening, group and polygon demos, delivery inspection, shutdown/reset.

- [ ] Add static tests for the web image, service command, port, and API proxy environment.
- [ ] Implement the minimal web image/service without changing backend services.
- [ ] Update documentation with exact commands and development-only auth warning.
- [ ] Run static tests, `docker compose config`, frontend build, and lint.
- [ ] Commit `docs: integrate frontend into local demo workflow`.

### Task 8: Final verification and clean handoff

- [ ] Run frontend tests, lint, and production build from `app/web/`.
- [ ] Run backend `npm test`, `npm run test:integration`, and `npm run lint` from `app/`.
- [ ] Start the clean Compose stack, verify web loads, groups render, submit group and polygon alerts, and observe terminal deliveries; shut it down cleanly.
- [ ] Run `git diff --check`, inspect status/log, and confirm no tokens, env files, or generated artifacts are tracked.
- [ ] Commit any final documentation-only corrections as a coherent commit and leave the worktree clean.
