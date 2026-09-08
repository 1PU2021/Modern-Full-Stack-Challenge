# Critical Notification Platform — Deployment Contract

This is the application-side source of truth for deploying the challenge
workload. It records the current commands, ports, configuration, database
access, queues, workload identity, probes, dependencies, and rollout order.
`app/docker-compose.yml` is the executable local reference and
`src/shared/config.js` is the backend configuration boundary. This document
does not prescribe a particular Helm chart or ingress controller.

## 1. Deployment architecture

```text
Browser -> web:5173 -> intake:3000 -> PostgreSQL/PostGIS
                            |
                            +-> transactional outbox -> alert-fanout SQS
                                                           |
                                                           v
                                      fanout:3001 -> PostgreSQL/PostGIS
                                                           |
                                                           v
                                              recipient-dispatch SQS
                                                           |
                                                           v
                                      dispatch:3002 -> PostgreSQL
                                                           |
                                                           +-> SMS:4000
                                                           +-> email:4001
```

The backend is one Node image with separate `intake`, `fanout`, `dispatch`,
and `stubs` commands. These processes remain independently deployable and
scalable. `web` is a separate image. `migrate` and `seed` use the backend image
as one-shot Jobs. PostgreSQL/PostGIS and SQS are managed dependencies in
deployed environments; ElasticMQ and provider stubs are demo substitutes.

## 2. Container inventory

| Workload | Image | Command | Ports | Kubernetes shape | Exposure |
|---|---|---|---|---|---|
| `web` | `app/web/Dockerfile` | Image default | 5173 | Deployment + Service | Public UI through ingress |
| `intake` | `app/Dockerfile` | `npm run intake` | 3000 | Deployment + Service | Public API through ingress |
| `fanout` | `app/Dockerfile` | `npm run fanout` | 3001 | Deployment | Internal ops/probes only |
| `dispatch` | `app/Dockerfile` | `npm run dispatch` | 3002 | Deployment | Internal ops/probes only |
| `stubs` | `app/Dockerfile` | `npm run stubs` | 4000, 4001 | Demo Deployment + ClusterIP | Internal only |
| `migrate` | `app/Dockerfile` | `npm run migrate up` | None | Job | Must complete first |
| `seed` | `app/Dockerfile` | `npm run seed` | None | Demo-only Job | Run after migrations |

Do not expose workers or provider stubs through public ingress. The current web
image runs Vite's development server; that is acceptable for this demo, while
a production static-file server remains deferred.

## 3. Per-workload contracts

### Web

- Listens on `5173`; use `GET /` as its health check.
- Calls intake through `VITE_API_BASE_URL` (normally `/api`).
- `VITE_PROXY_TARGET` must resolve to intake when the Vite proxy is used.
- Has no database, queue, provider, or AWS credential dependency.
- The browser needs Internet access for live OpenFreeMap tiles. The deterministic
  polygon preset remains usable without tiles.

### Intake

- Runs `npm run intake`; listens on `PORT` (`3000` in this contract).
- Exposes `GET /healthz`, `GET /readyz`, and `GET /metrics`.
- Uses low-privilege `APP_DATABASE_URL` for application data.
- Owns tenant/platform authentication, synchronous admin APIs, alert intake,
  and the transactional outbox publisher.
- Publishes to alert-fanout; requires SQS, PostgreSQL, completed migrations,
  both JWT secrets, and the intake workload IAM policy.
- Optionally needs outbound HTTPS to Nominatim when geocoding is enabled.

### Fanout

- Runs `npm run fanout`; listens on `PORT` (`3001`) for internal operations.
- Exposes `GET /healthz`, `GET /readyz`, and `GET /metrics`.
- Uses `APP_DATABASE_URL` and PostGIS to resolve group/polygon targets and
  create tenant-scoped delivery rows.
- Receives/deletes alert-fanout messages, reads both queue depths, and publishes
  recipient-dispatch messages.
- Requires SQS, PostgreSQL, completed migrations, and fanout workload IAM.

### Dispatch

- Runs `npm run dispatch`; listens on `PORT` (`3002`) for internal operations.
- Exposes `GET /healthz`, `GET /readyz`, and `GET /metrics`.
- Uses `APP_DATABASE_URL` for delivery bookkeeping.
- Receives/deletes recipient-dispatch messages and reads its depth.
- Calls the configured SMS/email HTTP endpoints.
- Requires SQS, PostgreSQL, providers, completed migrations, and dispatch IAM.

### Provider stubs

- Runs `npm run stubs`; SMS listens on `4000`, email on `4001`.
- Exposes `GET /healthz` on both ports and accepts `POST /sms/send` and
  `POST /email/send`.
- Has no database, queue, or AWS dependency and needs no workload IAM.
- Is an internal demo substitute, not a production provider integration.

### Migration Job

- Runs `npm run migrate up` with schema-owner `DATABASE_URL`.
- Requires the DDL, extension, role, and RLS-policy privileges used by the
  checked-in migrations.
- Has no port, queue dependency, or workload IAM requirement.
- Must succeed before seed or long-running services start.

### Seed Job

- Runs `npm run seed` after migrations and only for demo environments.
- Uses schema-owner `DATABASE_URL` to recreate fixed demo data.
- The script calls shared `loadConfig()`, so it currently also needs the
  validator-required values in section 4, although operationally it uses only
  PostgreSQL and `DEMO_USER_PASSWORD`.
- Has no port or AWS API calls and needs no workload IAM.

## 4. Configuration and secrets

### Complete catalog

| Variable | Purpose | Secret | Required/default |
|---|---|---:|---|
| `NODE_ENV` | Runtime mode | No | Optional; `development` |
| `PORT` | Backend listen port | No | Optional; `3000` |
| `LOG_LEVEL` | Pino level | No | Optional; `info` |
| `DATABASE_URL` | Schema-owner URL; compatibility value elsewhere | Yes | Required by loader/migration CLI |
| `APP_DATABASE_URL` | Low-privilege `app_user` URL | Yes | Required by loader |
| `AWS_REGION` | AWS SDK region | No | Required; infrastructure uses `us-east-2` |
| `SQS_ENDPOINT` | SQS endpoint override | No | Optional; omit for AWS SQS |
| `ALERT_FANOUT_QUEUE_URL` | Alert queue URL | No | Required by loader |
| `RECIPIENT_DISPATCH_QUEUE_URL` | Dispatch queue URL | No | Required by loader |
| `AWS_ACCESS_KEY_ID` | Static AWS credential | Yes | Local only; omit with workload identity |
| `AWS_SECRET_ACCESS_KEY` | Static AWS credential | Yes | Local only; omit with workload identity |
| `AWS_SESSION_TOKEN` | Temporary AWS credential | Yes | Never set manually with Pod Identity/IRSA |
| `JWT_SECRET` | Tenant-token signing key | Yes | Required by loader |
| `PLATFORM_JWT_SECRET` | Platform-token signing key | Yes | Required; must differ from `JWT_SECRET` |
| `DEMO_USER_PASSWORD` | Seeded demo password | Yes | Optional; demo default exists |
| `SMS_PROVIDER_URL` | Dispatch SMS endpoint | No | Optional; localhost default |
| `EMAIL_PROVIDER_URL` | Dispatch email endpoint | No | Optional; localhost default |
| `MAX_DELIVERY_ATTEMPTS` | Dispatch retry cap | No | Optional; `5` |
| `GEOCODER_PROVIDER` | `none` or `nominatim` | No | Optional; `none` |
| `GEOCODER_USER_AGENT` | Nominatim identification | No | Operationally required for Nominatim |
| `VITE_API_BASE_URL` | Browser API base | No | `/api` in Compose |
| `VITE_PROXY_TARGET` | Vite proxy destination | No | localhost default; intake in Compose |

Use Kubernetes Secrets for database URLs, JWT keys, the demo password, and any
static AWS credentials. Use ConfigMaps/deployment values for ports, region,
queue/provider URLs, retry/geocoder settings, and frontend routing. Prefer
workload identity in Kubernetes; do not create static AWS credential Secrets.

### Assignment matrix

`Used` means the process consumes the value. `Validator` means the current
shared schema requires it at startup although that workload does not use it.

| Variable group | Intake | Fanout | Dispatch | Seed | Migrate | Stubs | Web |
|---|---|---|---|---|---|---|---|
| Runtime/port/log | Used | Used | Used | Default | CLI | `NODE_ENV` only | No |
| `APP_DATABASE_URL` | Used | Used | Used | Validator | No | No | No |
| `DATABASE_URL` | Validator | Validator | Validator | Used | Used | No | No |
| Region + both queue URLs | Alert used; rest validator | Used | Dispatch used; rest validator | Validator | No | No | No |
| Both JWT secrets | Used | Validator | Validator | Validator | No | No | No |
| Demo password | Default | Default | Default | Used | No | No | No |
| Provider/retry values | Validator/default | Validator/default | Used | Validator/default | No | No | No |
| Geocoder values | Used | Validator/default | Validator/default | Validator/default | No | No | No |
| `VITE_*` | No | No | No | No | No | No | Used |

Validator-only requirements are implementation facts, not privilege grants.
For the unused `DATABASE_URL` in long-running pods, supply the same
low-privilege URL as `APP_DATABASE_URL`; never expose the real schema-owner URL
merely to satisfy validation. The schema-owner URL belongs only in migration
and demo-seed Jobs.

## 5. Database contract

PostgreSQL 16 with PostGIS is required. Infrastructure creates the instance,
networking, credentials, and extension capability; migrations create the
application schema, roles, indexes, and RLS policies.

| Workload | Operational connection | Privileges |
|---|---|---|
| Intake | `APP_DATABASE_URL` | `app_user`; forced RLS |
| Fanout | `APP_DATABASE_URL` | `app_user`; forced RLS and PostGIS queries |
| Dispatch | `APP_DATABASE_URL` | `app_user`; forced RLS |
| Migrate | `DATABASE_URL` | Schema owner/administrator |
| Seed | `DATABASE_URL` | Demo-only cross-tenant initialization |
| Web/stubs | None | No database access |

All tenant-owned application queries continue through `withTenant()`. Database
access requires private DNS/network reachability and security-group/firewall
rules from workload pods or nodes to PostgreSQL `5432`.

## 6. Queue and workload-IAM contract

Set the two queue URL variables to deployed SQS URLs; omit `SQS_ENDPOINT` for
AWS. Terraform exposes the primary queue URLs and ARNs.

| Workload | Alert-fanout | Recipient-dispatch |
|---|---|---|
| Intake | `SendMessage` | No logical access |
| Fanout | `ReceiveMessage`, `DeleteMessage`, `GetQueueAttributes` | `SendMessage`, `GetQueueAttributes` |
| Dispatch | No logical access | `ReceiveMessage`, `DeleteMessage`, `GetQueueAttributes` |

SQS performs DLQ redrive. Application pods need no direct DLQ access and no
`sqs:*`, queue creation/list/purge, `GetQueueUrl`, or
`ChangeMessageVisibility` permission.

### Recommended production model

Use three Kubernetes service accounts, IAM roles, and Pod Identity associations:

| Role | Least-privilege policy |
|---|---|
| Intake | `sqs:SendMessage` on alert-fanout ARN |
| Fanout | Receive/delete/get attributes on alert-fanout; send/get attributes on recipient-dispatch |
| Dispatch | Receive/delete/get attributes on recipient-dispatch |

The EKS module already installs the Pod Identity Agent. Each Deployment must
set its associated `serviceAccountName`. IRSA is an acceptable alternative if
that is the cluster standard. Never attach application queue permissions to the
node role or default Kubernetes service account.

### Acceptable demo simplification

For a short-lived demo, intake, fanout, and dispatch may share one application
service account and workload role. Its policy is the union:

- Alert-fanout ARN: `sqs:SendMessage`, `sqs:ReceiveMessage`,
  `sqs:DeleteMessage`, `sqs:GetQueueAttributes`.
- Recipient-dispatch ARN: `sqs:SendMessage`, `sqs:ReceiveMessage`,
  `sqs:DeleteMessage`, `sqs:GetQueueAttributes`.

This intentionally increases blast radius because every application worker can
publish to and consume from both queues. It is acceptable only as a documented
demo trade-off. It must remain a workload role limited to these three services,
not a node role, and include no DLQ or unrelated AWS permissions.

Queues currently use SQS-managed encryption, so these roles need no KMS access.
A future customer-managed key requires a separate policy review.

## 7. Networking, probes, and shutdown

| Component | Port | Kubernetes guidance |
|---|---:|---|
| Web | 5173 | Service + public ingress |
| Intake | 3000 | Service + API ingress route |
| Fanout ops | 3001 | Direct probes; optional internal metrics Service |
| Dispatch ops | 3002 | Direct probes; optional internal metrics Service |
| SMS/email stubs | 4000/4001 | Demo-only ClusterIP |
| PostgreSQL | 5432 | Private managed endpoint |
| ElasticMQ | 9324 | Local only; use SQS when deployed |

Intake, fanout, and dispatch expose `/healthz` (liveness, no DB query),
`/readyz` (includes `SELECT 1` and shutdown state), and `/metrics`. Stubs expose
`/healthz` on both ports. Web uses `GET /`.

Use `terminationGracePeriodSeconds: 30` or greater; the application grace
deadline is 25 seconds. Services stop readiness and new work before draining
in-flight operations. Interrupted durable work remains retryable.

## 8. Step-by-step deployment

1. **Build/publish images.** Build `app/Dockerfile` once for all backend roles
   and `app/web/Dockerfile` for web; record immutable tags/digests.
2. **Provision PostgreSQL/PostGIS.** Establish private connectivity and the
   schema-owner and low-privilege application credentials.
3. **Provision SQS.** Create both primary queues and DLQs; capture primary URLs
   and ARNs.
4. **Create namespace/workload identities.** Prefer separate roles; use the
   documented shared role only for an intentional demo simplification.
5. **Create ConfigMaps and Secrets.** Populate section 4, keep JWT keys
   distinct, omit `SQS_ENDPOINT` and static credentials with workload identity,
   and keep the schema-owner URL out of long-running pods.
6. **Run migrations.** Do not continue unless the Job completes successfully.
7. **Seed demo data if required.** Skip for non-demo data sets.
8. **Deploy providers.** Deploy/verify stubs for the demo or configure reachable
   real provider endpoints.
9. **Deploy intake.** Wait for `/readyz` before routing traffic.
10. **Deploy fanout.** Verify readiness and both queue-depth metrics.
11. **Deploy dispatch.** Verify readiness and provider reachability.
12. **Deploy web/ingress.** Route the UI and `/api` consistently to intake.
13. **Run the acceptance checks below.** Do not call deployment complete until
    the durable alert path and tenant isolation are verified.

Compose expresses equivalent local gates through health and completed-job
dependencies.

## 9. Deployment verification

- [ ] Migration Job succeeded; demo Seed Job succeeded where applicable.
- [ ] Intake, fanout, and dispatch liveness/readiness pass.
- [ ] Web is reachable; workers and stubs are not publicly exposed.
- [ ] Tenant login works with seeded email/password only—no tenant slug or JWT.
- [ ] Separate platform-admin login works.
- [ ] Impersonation enters tenant mode and exits to the preserved platform session.
- [ ] A group alert traverses outbox, both queues, workers, and terminal rows.
- [ ] The deterministic polygon produces a non-zero geographic subset.
- [ ] A different tenant cannot read that alert or its deliveries.
- [ ] All three backend `/metrics` endpoints are scrapeable.
- [ ] Infrastructure queue and DLQ alarms are configured as intended.

The token helper remains optional for curl/automated testing and is not a
browser-login or deployment requirement:

```bash
cd app
npm run token -- --tenant=demo-county --user=admin@demo-county.test
```

## 10. Local reference

```bash
cd app
docker compose up --build
npm run smoke:local
docker compose down
docker compose down -v   # full data reset
```

The UI is `http://localhost:5173`; intake is `http://localhost:3000`. If host
port 5432 is occupied, pass the same override to every Compose command, such as
`POSTGRES_PORT=55432 docker compose up --build`. Compose credentials and static
AWS keys are local-only.

## 11. Known limitations

- Authentication and seeded credentials are demo-grade; there is no production
  identity provider, reset/refresh flow, or MFA.
- Provider stubs replace real integrations and use code-default personalities.
- Processing is at least once, not exactly-once provider invocation.
- Map tiles require browser Internet; Nominatim requires intake egress and a
  valid identifying user agent.
- Local ElasticMQ uses 60-second visibility timeouts and has no checked-in
  DLQ/redrive configuration. Terraform-provisioned SQS queues do have DLQs.
- Browser E2E automation for MapLibre/Terra Draw remains deferred.
- Shared backend configuration currently requires some unused validator values,
  as identified in section 4.
