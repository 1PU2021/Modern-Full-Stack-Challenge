# Reproducible Local Demo Environment Design

## Goal

Make the complete backend pipeline reproducibly runnable with one Docker
Compose command, deterministic seed data, and a development JWT helper.

The existing intake, fanout, dispatch, provider-stub, migration, and RLS
contracts remain unchanged. This phase adds only local orchestration and
developer tooling; it does not implement the frontend.

## Chosen architecture

`app/docker-compose.yml` defines one PostGIS database, one ElasticMQ service,
one one-shot migration service, one one-shot seed service, the three workers,
and the provider stubs. Compose health checks and `condition:
service_healthy`/`service_completed_successfully` gates express readiness;
application processes still retain their own `/readyz` checks and retry-safe
startup behavior.

All application services use the low-privilege `APP_DATABASE_URL`. Only the
migration and seed jobs use the admin `DATABASE_URL`. No RLS policy is
weakened and no schema is changed.

The application image is a straightforward Node 22 slim image because the
checked-in package declares `engines.node >=22`; Node 22 satisfies the project
Node 20+ runtime floor. Dependencies are installed from the lockfile and the
image runs one of the existing package scripts (`intake`, `fanout`,
`dispatch`, `stubs`) selected by Compose.

ElasticMQ is configured from a checked-in file with queues named exactly
`alert-fanout` and `recipient-dispatch`. Compose injects service-host queue
URLs while `.env.example` retains localhost URLs for non-container runs.

## Initialization and rerun behavior

The `migrate` service runs `npm run migrate up` once after PostgreSQL reports
healthy. The `seed` service then runs `npm run seed` and exits successfully.
`docker compose up --build` therefore initializes an empty volume before
starting workers. Re-running seed is safe: fixed UUID rows are upserted and
demo-owned child rows are reset inside a transaction before regeneration.
Removing volumes (`docker compose down -v`) performs a full reset.

## Seed data

`scripts/seed.js` connects with `DATABASE_URL` and inserts two fixed tenants,
one operator per tenant, three groups per tenant, 150 recipients per tenant,
group memberships, and deterministic PostGIS points across two metro-like
bounding boxes. One group is broad, one is a smaller emergency subset, and
one is an empty demonstration group. Phone/email fields are clearly fake.
The script prints the seeded tenant slugs and operator emails but never prints
secrets.

## Development JWT helper

`scripts/generate-dev-token.js` accepts `--tenant=<slug>` and
`--user=<email>` (with documented defaults), looks up the seeded user through
the admin connection, and prints a one-line HS256 token signed with
`JWT_SECRET`. It is explicitly development-only, does not create users, and
does not change production authentication.

## Developer workflow

```bash
cd app
docker compose up --build
# in another shell, from app/
npm run token -- --tenant=demo-county --user=admin@demo-county.test
curl -X POST http://localhost:3000/api/v1/alerts ...
curl http://localhost:3000/api/v1/alerts -H "Authorization: Bearer $TOKEN"
docker compose down
docker compose down -v   # full reset
```

README documents group and polygon requests, alert/delivery inspection, and
the distinction between stopping containers and deleting local state.

## Testing

Unit tests cover seed planning/idempotent SQL helpers and token argument/
claim behavior without requiring Docker. Compose syntax is validated with
`docker compose config` when Docker is available. A smoke script/test starts
the Compose stack, waits for health, runs migration/seed through Compose,
generates a token, submits a group alert, and polls until a terminal delivery
outcome; it is kept opt-in so ordinary unit/integration tests do not depend on
the Docker daemon.

## Deliberate limitations

Credentials are non-production demo defaults supplied through Compose. The
stack has no TLS, secret manager, autoscaling, persistent queue redrive policy,
frontend, or production image hardening. Those remain deferred scope.
