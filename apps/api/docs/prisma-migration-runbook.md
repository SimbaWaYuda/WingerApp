# Prisma database migration runbook

**Stage:** S2.6.20.32 (created); S2.6.20.34 (corrections)  
**Status:** Documentation only. Does not provision databases, apply migrations, or change application configuration.  
**Verified against:** S2.6.20.31 readiness audit and S2.6.20.33 independent review (Prisma 5.22.0, 42 migrations, single `DATABASE_URL`, no `directUrl` in schema).

This runbook is for a future dedicated production PostgreSQL host. The current workstation database and any temporary tunnel are **not** the production system.

---

## 1. Architecture

| Item | Current state |
|------|----------------|
| ORM / CLI | Prisma **5.22.0** (`@prisma/client` dependency; `prisma` CLI is a **devDependency**) |
| Database | PostgreSQL (`provider = "postgresql"`) |
| Schema | `apps/api/prisma/schema.prisma` |
| Migrations | `apps/api/prisma/migrations/` — **42** directories, chronological, additive |
| Lock file | `apps/api/prisma/migrations/migration_lock.toml` → `provider = "postgresql"` |
| Runtime client | `PrismaService` extends `PrismaClient` and connects on module init |
| Production image | Docker build runs `prisma generate`, then `npm prune --omit=dev`; runtime CMD is `node dist/main.js` only |

### Connection configuration today

- Datasource uses **only** `url = env("DATABASE_URL")`.
- There is **no** `directUrl` / `DIRECT_URL` in the schema.
- The Nest API does **not** run migrations at startup.
- Deploy-oriented script: `npm run db:migrate:deploy` → `prisma migrate deploy`.
- Dev-oriented scripts (`prisma migrate dev`, `db:setup`, seed) are for local development, not production releases.

Prisma Client uses its default process pool sized from the runtime URL (including optional `connection_limit` query params). Do not confuse that client pool with an external transaction pooler (PgBouncer and similar).

### Production image versus migration executor

Inspected facts from `apps/api/Dockerfile` and `apps/api/package.json`:

- The production application image runs **`npm prune --omit=dev`** after build.
- The **Prisma CLI** (`prisma`) is declared under **`devDependencies`**.
- After prune, operators **must not assume** the pruned application image can run `prisma migrate deploy` or `npm run db:migrate:deploy`.
- `@prisma/client` remains available for the running API; that is **not** a substitute for the Prisma CLI.

**Migrations must run from a separate Prisma-CLI-capable release environment**, not from the pruned runtime container `CMD`.

Acceptable approaches (choose one; **do not implement in this document**):

- A dedicated migration image that keeps the Prisma CLI and full install needed for `migrate deploy`, or
- A controlled release job (CI/CD step or operator workstation) with `npm ci` (or equivalent) so `prisma` is present, using the **same** application release’s `package-lock.json`, Prisma version, `schema.prisma`, and `prisma/migrations` tree.

Requirements for that environment:

1. Supply the correct production (or staging) **`DATABASE_URL`** secret for the target database.
2. Use the **same Prisma version and migration files** as the application release being rolled out.
3. Complete migration **successfully** (including verification in section 8) **before** application rollout of instances that expect the new schema.
4. Never start application replicas that each attempt migrate on boot.

---

## 2. `DATABASE_URL` and when `DIRECT_URL` is needed

### `DATABASE_URL`

- `DATABASE_URL` is a **secret**. Never print, commit, or paste real credentials into docs, tickets, or logs. Refer to secret names and hosts only.
- It must be supplied to:
  - the **migration job / Prisma-CLI-capable executor** (so `prisma migrate deploy` can reach the database), and
  - the **application runtime** (so Nest/`PrismaService` can query PostgreSQL).
- The application **must** receive a valid `DATABASE_URL` in production. Do **not** interpret “keep secrets out of the repo” as “the app runs without a database connection.”
- Production env validation (`NODE_ENV=production`) requires a PostgreSQL `DATABASE_URL`.
- Used today by `prisma migrate deploy` because no separate direct URL is configured (CLI and app share the same env var name; inject it into each process that needs it).

### When a single `DATABASE_URL` is enough

Use one **direct** (non-pooled) PostgreSQL URL for both the app and `prisma migrate deploy` when:

- The host exposes a dedicated Postgres instance without a transaction-mode pooler, or
- Application and migrate job both connect to the same direct endpoint by design.

This matches the current schema and is the default recommendation until a provider with a pooler is chosen.

### When `DIRECT_URL` becomes necessary

Introduce a separate direct migration URL **only if** runtime traffic goes through a **transaction pooler** (for example PgBouncer in transaction mode, Neon pooled, or similar), because:

- `prisma migrate deploy` needs session features (advisory locks, DDL) that poolers often break.
- Prisma 5.22 supports `directUrl = env("DIRECT_URL")` on the datasource for CLI migrate/introspect while keeping `url` pooled for the app.

**Do not add `directUrl` to `schema.prisma` until that hosting decision is made.** Adding it without a real `DIRECT_URL` would break migrate and generate flows.

| Hosting shape | App (`DATABASE_URL`) | Migrate |
|---------------|----------------------|---------|
| Dedicated direct Postgres | Direct URL (secret on app **and** migrate job) | Same direct URL secret on the migrate executor |
| Pooled runtime + direct admin endpoint | Pooled URL on app | Direct URL via future `DIRECT_URL` / `directUrl` on the migrate executor |

---

## 3. Safety rules (non-negotiable)

1. **Never** run migrations from the Docker application `CMD` or from Nest bootstrap.
2. **Never** assume the pruned production application image can run the Prisma CLI.
3. **Never** assume a migration can be rolled back. Prisma migrations in this repo are **forward-only**.
4. **Never** apply production migrations without a **verified** backup **and** a practiced restore path.
5. Validate migrations that touch existing data on **staging** before production.
6. **Do not** expose database credentials in logs, screenshots, chat, or documentation.
7. **Do not** run `prisma migrate deploy` from multiple release jobs or replicas at the same time. Prefer one explicit migrate step owned by the release process. (Prisma takes a PostgreSQL advisory lock during deploy; that is a safety net, not permission to start concurrent migrate jobs.)
8. **Do not** treat a successful migrate command alone as proof the application is ready. Confirm `_prisma_migrations`, schema expectations, and a post-migrate smoke check.
9. **Do not** roll out application instances that require a new schema until migrate has succeeded and been verified.
10. **Do not** run `prisma db seed` against production unless a separate, explicit authorisation says so. Seed is a development concern.
11. **Do not** start production migrate without completing the approval checklist (section 11a) and filling an execution record (section 11b).

---

## 4. Provider-dependent decisions (unresolved)

No production host is assumed (including Render or any other vendor). Before first production migrate, owners must decide:

| Decision | Why it matters |
|----------|----------------|
| Database product / region / plan | Connection string shape, SSL, latency |
| Connection pooling | Whether `DIRECT_URL` + schema `directUrl` are required |
| Backup and PITR availability | RPO/RTO and restore tooling |
| Restore procedure | Who runs restore, how long it takes, how apps are pointed |
| Staging vs production databases | Dry-run of the same 42-migration set against realistic data |
| Who executes migrate | Single Prisma-CLI-capable release job vs dedicated migrate image vs manual operator |
| Whether production ever receives seed data | Demo supplier backfills must not be mistaken for prod setup |

Document the chosen answers in the release checklist for that environment; do not invent provider defaults here.

---

## 5. Migration inventory summary

- **Count:** 42 migration directories under `apps/api/prisma/migrations/`.
- **Character:** Additive (create tables/enums/columns/indexes). No `DROP TABLE` / `TRUNCATE` migrations were identified in the S2.6.20.31 audit.
- **Forward-only enum extensions:** e.g. `CommissionRecognitionStatus` → `CLAWED_BACK`; `PaymentReconcileManualReviewReason` → `IDENTITY_MISMATCH`.
- **Empty database:** Safe to initialise with `prisma migrate deploy` from migration 1 through 42.
- **Existing-data database:** Generally additive, but see risks below. Always dry-run on staging first.

### Higher-attention risks

| Area | Why |
|------|-----|
| Unique indexes on `Order.stripePaymentIntentId` and `Order.checkoutIdempotencyKey` | Deploy fails if duplicate non-null values already exist |
| Non-concurrent indexes (e.g. payment reconcile lease index on `Order`) | Can lock/write-block longer on large tables |
| Backfills (`ProductImage` insert; `Order`/`OrderItem`/`ReturnRequest`/`PlatformSettings` updates; demo supplier location updates) | Safe on empty DB; cost and correctness grow with real data |
| Large commission / refund table creations | DDL time and lock behaviour depend on host load |

---

## 6. Empty database initialisation

Use this for a brand-new staging or production database with **no** application data.

1. Provision an empty PostgreSQL database on the chosen host (provider-specific).
2. Inject the `DATABASE_URL` secret into the **Prisma-CLI-capable migration executor** (secret store / CI secret — never commit it). The future application runtime will also need this secret (or the equivalent direct/pooled pair if a pooler is introduced later).
3. In that migrate environment, from `apps/api` (or the release artifact that contains the same lockfile, Prisma version, and `prisma/migrations`):

   ```bash
   npm run db:migrate:deploy
   ```

   Equivalent: `npx prisma migrate deploy`

4. Verify (section 8).
5. Only after migrate succeeds: start/roll out the **pruned application image** (or equivalent runtime) that already ran `prisma generate` at build time. Do not migrate from that image.
6. Run application smoke checks (section 9). Do **not** seed unless authorised.

---

## 7. Staging migration and verification

Staging must use a **separate** database from production.

### Empty staging

Follow section 6, then smoke-test the API against staging (`GET /health` and capability-appropriate checks in section 9).

### Staging with existing / restored data

1. Restore a recent anonymised or scrubbed production-like dump into staging (provider restore procedure).
2. Confirm a verified backup of that staging copy if you will experiment further.
3. Run **one** `npm run db:migrate:deploy` from a Prisma-CLI-capable executor against staging.
4. Complete section 8 verification.
5. Exercise paths that depend on migrated columns (orders, payments metadata, inventory, commissions as applicable).
6. Only after staging succeeds, schedule production (complete section 11a first).

Existing-data migrations in this repo include backfills and unique indexes. Staging is where those failures must surface.

---

## 8. `_prisma_migrations` and schema verification

After every successful deploy migrate:

1. Confirm `prisma migrate deploy` exited **0**.
2. Confirm migrate status shows **no pending** migrations for this revision (e.g. `npx prisma migrate status`).
3. Confirm `_prisma_migrations` contains a successful row for each expected migration directory of the release (for a greenfield apply of current `developer` history: **42** applied migrations).
4. Spot-check critical relations/enums the release depends on (orders, payment fields, inventory ledger, commission tables) with read-only SQL or Prisma Studio against **non-production** first.
5. Confirm the running API build was generated from the **same** schema/migration revision you just deployed.

A green migrate CLI result without status/`_prisma_migrations` checks is incomplete.

---

## 9. Application readiness after migrate

Migration success ≠ application readiness. After migrate:

1. Deploy or restart API instances that **do not** run migrate themselves (pruned runtime image / service).
2. Confirm process health: `GET /health` should report ok; also confirm the listen port.
3. Smoke: authenticated read of catalog or settings; place a non-card path if enabled (COD/Lipa) or a read-only admin check — per environment capability.
4. Confirm payment reconcile worker remains **off** unless separately authorised (`PAYMENT_RECONCILE_WORKER_ENABLED` unset).
5. Watch logs for Prisma connection or schema-mismatch errors (without logging connection strings).
6. Record results in the execution record (section 11b).

---

## 10. Production backup requirements

Before the **first** production `migrate deploy`, and before any later migrate on a database with real data:

1. Take a provider backup or snapshot that meets the agreed RPO.
2. Record backup id / timestamp / region in the execution record (no credentials).
3. Confirm the **restore procedure** has been practiced on staging or a disposable clone.
4. Confirm who can restore, how long restore takes, and how DNS/app config is repointed.
5. If PITR is available, note the restore window and how to halt writes during recovery.

**No verified backup + restore drill ⇒ no production migrate.**

---

## 11. Controlled production migration execution

Recommended release shape:

1. Complete **production migration approval** (section 11a). Do not proceed without explicit authorisation.
2. Freeze or drain writers if the change set warrants it (owner decision; large locks / backfills).
3. Ensure **exactly one** Prisma-CLI-capable migrate executor will run for this release (not the pruned app image; not multiple jobs).
4. Apply backup checklist (section 10).
5. Open an **execution record** (section 11b) and note start time.
6. Run `npm run db:migrate:deploy` once with the production `DATABASE_URL` secret injected privately into that executor.
7. Verify `_prisma_migrations` / migrate status (section 8); record exit code and verification.
8. Only then roll forward application instances (no migrate in container CMD).
9. Application smoke (section 9); record outcome.
10. Keep the previous app image and backup id available until smoke passes.
11. Close the execution record with final outcome.

### Separation from application startup

| Process | Responsibility |
|---------|----------------|
| Prisma-CLI-capable migrate executor | `prisma migrate deploy` exactly once, before app rollout |
| Pruned application container / service | Serve traffic; `prisma generate` already done at image build; **no** Prisma CLI required at runtime |
| Docker `CMD` | Must remain application start only (`node dist/main.js`) |

Never start N replicas that each attempt migrate on boot. Never use the pruned runtime image as the migrate executor unless a future change explicitly keeps the Prisma CLI (not true of the current Dockerfile).

### Preventing concurrent migrate jobs

- Pipeline: single sequential “migrate” step with concurrency group / mutex for the environment.
- Manual: one operator, one Prisma-CLI-capable session, one environment URL.
- Do not trigger overlapping deploys that both include migrate.
- Rely on Prisma’s advisory lock only as a last-resort guard, not as a scheduling strategy.

---

## 11a. Production migration approval checklist

Complete **before** production `migrate deploy`. All items required.

- [ ] **Approved application release/version** (tag, image digest, and/or git commit): _______________
- [ ] **Reviewed migration list** for this release (pending names / expected apply set): _______________
- [ ] **Staging migration result** attached or linked (exit 0, status clean, smoke passed): _______________
- [ ] **Verified backup identifier** recorded: _______________
- [ ] **Restore readiness** confirmed (procedure practiced; owner named): _______________
- [ ] **Approved migration executor** identified (Prisma-CLI-capable job/image/host — not pruned app image): _______________
- [ ] **Named operator** (who will run migrate): _______________
- [ ] **Named approver** (who authorises production execute): _______________
- [ ] **Explicit authorisation** to run production migrate is granted (approver sign-off / ticket): _______________

**Stop** if any box is unchecked.

---

## 11b. Migration execution record template

Copy for each staging or production migrate. Do not paste secrets.

| Field | Value |
|-------|--------|
| Environment | staging / production / other: _______________ |
| Application release / commit | _______________ |
| Migration executor / image version | _______________ |
| Operator | _______________ |
| Approver | _______________ |
| Start timestamp (UTC) | _______________ |
| Finish timestamp (UTC) | _______________ |
| Backup identifier | _______________ |
| Migration names applied | _______________ |
| Command | e.g. `npm run db:migrate:deploy` |
| Command exit code | _______________ |
| `_prisma_migrations` verification | pass / fail + notes: _______________ |
| `prisma migrate status` | no pending / other: _______________ |
| Application smoke-test result | pass / fail + checks run: _______________ |
| Outstanding issues | _______________ |
| Final outcome | success / aborted / restored from backup: _______________ |

---

## 12. Failed or partially applied migrations

Prisma records failed attempts in `_prisma_migrations`. It does **not** automatically undo DDL.

If `migrate deploy` fails:

1. **Stop** further migrate retries and pause the release that would start new app versions expecting the new schema.
2. Capture the error message and the migration name (no credentials); update the execution record.
3. Inspect `_prisma_migrations` for a failed / incomplete entry for that migration.
4. Determine whether the database object changes partially landed (read-only `\d` / information_schema checks).
5. Choose recovery:
   - **Forward fix:** repair schema manually only under an explicit engineering change control, then use `prisma migrate resolve` as documented by Prisma for that situation — only with owner approval. Mis-use of `--applied` vs `--rolled-back` is dangerous; follow current Prisma docs exactly.
   - **Restore:** restore from the pre-migrate backup (section 13), then reassess.
6. Do not delete migration history rows casually.
7. Re-run staging with a fix **before** another production attempt.
8. Do not roll out the new application image until the database is consistent with that release.

---

## 13. Backup restoration and forward-only recovery

- There is **no** supported `migrate down` path for this repository’s history.
- Recovery from a bad production migrate is **restore the backup** (or PITR to before migrate), then decide whether to retry a fixed forward migration.
- After restore, confirm `_prisma_migrations` matches the restored data era before starting the API version that expects newer columns.
- Re-apply only with a new verified backup, completed staging proof, and a fresh approval checklist (section 11a).

---

## 14. Checklist templates

### Empty DB (staging or production)

- [ ] Database provisioned; `DATABASE_URL` secret available to migrate job **and** (when rolling out) application runtime  
- [ ] Hosting decisions recorded (pooler? backup?)  
- [ ] Prisma-CLI-capable single migrate executor identified (not pruned app image)  
- [ ] Same Prisma version + migration files as the app release  
- [ ] Production only: section 11a approval complete  
- [ ] Execution record opened (section 11b)  
- [ ] `npm run db:migrate:deploy` exit 0  
- [ ] `migrate status` clean; `_prisma_migrations` matches release  
- [ ] API started without migrate-on-boot  
- [ ] Smoke checks passed  
- [ ] Seed **not** run (unless authorised)  
- [ ] Execution record closed  

### Existing-data production

- [ ] Staging dry-run on comparable data passed  
- [ ] Section 11a approval complete  
- [ ] Backup taken and restore drill verified  
- [ ] Maintenance / lock risk acknowledged for indexes and backfills  
- [ ] Single Prisma-CLI-capable migrate job  
- [ ] Deploy migrate → verify → then app rollout → smoke  
- [ ] Rollback plan = restore backup, not migrate down  
- [ ] Execution record complete  

---

## 15. Related commands (reference)

Run from a **Prisma-CLI-capable** checkout/artifact of `apps/api` with the correct `DATABASE_URL` (and future `DIRECT_URL` if configured) in that process environment:

| Intent | Command |
|--------|---------|
| Apply pending migrations (staging/prod) | `npm run db:migrate:deploy` |
| Show migrate status | `npx prisma migrate status` |
| Generate client (CI/image build) | `npm run prisma:generate` |
| Local interactive migrate (dev only) | `npm run prisma:migrate` |
| Seed (dev / authorised only) | `npm run prisma:seed` |

Do not use `prisma migrate dev` or `db push` against shared staging/production.  
Do not rely on these commands inside the pruned production application image.

---

## 16. Document control

| Field | Value |
|-------|--------|
| Created | S2.6.20.32 |
| Corrected | S2.6.20.34 — migrate executor vs pruned image; approval checklist; execution record; `DATABASE_URL` wording |
| Basis | S2.6.20.31 read-only audit; S2.6.20.33 independent review |
| Code/schema changes in this stage | None |
| Next implementation (separate authorisation) | Optional dedicated migrate image or release job; optional `directUrl` only if a pooler is chosen; hosting provision; first staging migrate |
