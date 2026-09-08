# Application Acceptance Matrix (2026-08-26)

| Requirement | Implementation evidence | Test/smoke evidence | Status |
|---|---|---|---|
| Authenticated tenant-scoped intake API | `src/intake`, JWT middleware, `withTenant()` | 47 integration tests including cross-tenant 404/RLS checks | Pass |
| Durable intake publication | Transactional `alert_outbox` and publisher | Outbox integration tests and backend smoke path | Pass |
| Group and PostGIS polygon fanout | `src/fanout` store/processor | Fanout integration tests for groups, polygons, duplicates, isolation | Pass |
| Dispatch outcomes/retries | `src/dispatch`, provider classification and max attempts | Dispatch integration/unit tests including retry and terminal failure | Pass |
| SMS/email provider stubs | `src/stubs` deterministic personalities | Stub unit tests and end-to-end delivered smoke | Pass |
| Required operational endpoints | Intake/fanout/dispatch ops routes | Unit coverage for health/readiness/metrics | Pass |
| PostGIS, queues, migrations, seed, dev token | `docker-compose.yml`, `elasticmq.conf`, scripts | Compose build/config and local smoke path | Pass |
| Frontend React/Vite admin UI | `app/web`, Compose `web` service | 12 frontend tests, lint/build, Compose web-load check | Pass |
| Alert compose/list/detail/groups workflows | React views and API client | Component tests for payloads, states, counts, deliveries | Pass |
| Polygon map targeting | MapLibre + Terra Draw + OpenFreeMap editor | Build and polygon serialization/component test | Pass (browser interaction not automated) |
| Clean-room UI end-to-end group + polygon rehearsal | Backend smoke and web startup verified | Group delivery smoke passed; browser-driven polygon rehearsal not available in CLI | Partial |
| ElasticMQ DLQ/redrive after five receives | Not configured in current local queue config | No DLQ acceptance test | Deferred-by-design (infrastructure hardening) |
| Production auth, real providers, frontend E2E browser stack | Explicitly out of scope | Not applicable | Deferred-by-design |

## Remaining application risk

The primary unautomated acceptance item is browser-level interaction with the
MapLibre/Terra Draw editor; the payload and build are tested, but a headless
browser rehearsal is not part of this demo-grade repository. The local
ElasticMQ DLQ/redrive policy remains deferred infrastructure work.
