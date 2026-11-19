# Deployment (#144)

## Pipeline

1. **Verify** — CI jobs (contract sync, migrations, build, tests, actionlint,
   shellcheck).
2. **Image** — buildx pushes `ghcr.io/<repo>@sha256:<digest>`, cosign signs the
   digest, Syft emits an SPDX SBOM.
3. **Staging** — `deploy-env.yml` verifies the cosign identity, lints migrations
   and runs `helm upgrade --install --atomic`.
4. **Staging checks** — readiness must hold 3 consecutive probes, indexer lag
   must be ≤ 120 ledgers and the cursor must advance.
5. **Production** — same reusable workflow with the production GitHub
   Environment (required reviewers).
6. **Production checks** — 5 consecutive readiness probes plus the same lag,
   cursor and Prometheus checks.

Secrets (kubeconfig, Helm values) live in GitHub Environments. The image is
referenced by digest, never by a mutable tag.

## Migration rule: expand / contract

`scripts/check-migration-compat.mjs` (run on the migrations changed in a PR/release) blocks:

- `DROP TABLE`, `DROP COLUMN`, `RENAME`;
- `ALTER COLUMN … TYPE`;
- `SET NOT NULL`;
- `CREATE INDEX` without `CONCURRENTLY`.

Ship additive migrations first, deploy both versions, then remove old columns
in a later release. `--allow-breaking` exists only for an explicitly approved
maintenance window.

## Admin RBAC first deploy (#49)

Ship the `20261019110000_admin_rbac` migration before the new image. On first
boot the process seeds the fixed permission/role catalogue and assigns every
`ADMIN_ADDRESSES` entry as `super_admin` under an advisory lock. After that the
database is authoritative: removing an address from the environment does **not**
revoke it, and the env list is never consulted per request. Grant/revoke and
treasury writes require a wallet proof no older than `STEP_UP_MAX_AGE_SECONDS`.
If the seed cannot complete, the process refuses to boot rather than serve
without an admin role catalogue.

## Payment intent confirmer (#52)

`startPaymentIntentCron` runs every `PAYMENT_INTENT_CONFIRM_CRON` (default
`*/20 * * * * *`) and uses the same per-hash advisory lock as the legacy unlock,
so all replicas can schedule it safely. It is bounded by
`PAYMENT_INTENT_CONFIRM_BATCH` and backs off up to
`PAYMENT_INTENT_MAX_ATTEMPTS`. Set `PAYMENT_INTENT_CONFIRM_ENABLED=false` to
pause it without blocking interactive `POST /…/submit` calls.

## Rollback

Roll back the Helm release to the previous revision. If the new release added
only expand-phase changes, the old code keeps working. Do **not** roll back the
database; forward-fix instead.

## Post-deploy checks

```bash
API_URL=https://api.example \
INDEXER_STATUS_URL=https://api.example/internal/indexer-status \
MAX_INDEXER_LAG_LEDGERS=120 \
PROMETHEUS_URL=https://prometheus.example \
KUBE_NAMESPACE=oracledesk DEPLOYMENTS="api indexer worker" \
DIGEST=<sha256> ./scripts/post-deploy-checks.sh
```

Checks are read-only. `SKIP_KUBE=1` omits the digest check in local tests.

## Migrations

### Naming convention

Every new migration folder must start with a 14-digit timestamp prefix (`YYYYMMDDHHMMSS`) followed by `_` and a descriptive slug, e.g. `20261019140000_payment_intents`. The prefix must be **strictly greater** than every existing prefix. Duplicate prefixes break Prisma's lexical ordering and are caught by `npm run lint:migrations`.

### Checking for drift

`npm run check:drift` applies all migrations to a shadow database, then diffs in both directions between the applied schema and `prisma/schema.prisma`. It fails if any object appears in one side but not the other and is not listed in `prisma/drift-allowlist.json`.

Run locally:

```bash
# auto-creates oracledesk_shadow_<pid> and drops it on exit
DATABASE_URL=postgresql://... npm run check:drift

# or supply your own shadow DB
DATABASE_URL=postgresql://... SHADOW_DATABASE_URL=postgresql://...shadow npm run check:drift
```

### Drift allowlist (`prisma/drift-allowlist.json`)

Objects intentionally managed outside the datamodel (HNSW indexes, partial uniques, the `vector` extension) are listed here with a `reason`. Temporary entries carry an `expires` date; `check:drift` fails once that date has passed to prevent exemptions from going stale.

### Renumbering collision prefixes

The `prisma/migration-renames.json` map lists all historical prefix collisions and their unique replacements. Before deploying to a fresh environment or after a restore, run:

```bash
# Update _prisma_migrations rows (idempotent — safe to run twice)
DATABASE_URL=postgresql://... node scripts/renumber-migrations.mjs --apply-db

# Then rename the folders (only needed once per checkout)
node scripts/renumber-migrations.mjs --apply-fs
```

**Rollback:** swap `from` and `to` in the map and re-run `--apply-db` on the database, then `--apply-fs` on the checkout. The file contents (and their checksums) are unchanged, so Prisma's integrity check is unaffected.

**Order matters:** run `--apply-db` _before_ `prisma migrate deploy` so the applied-name rows match the folder names.
