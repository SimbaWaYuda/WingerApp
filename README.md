# Winger

One connected marketplace with three role-based experiences:

- **Customer** — search, compare, cart, checkout, split-shipment tracking  
- **Supplier** — dashboard, orders, products/inventory, payments  
- **Administrator** — platform KPIs, suppliers, orders, delivery

## Stack

| Layer | Choice |
|-------|--------|
| Clients | Flutter (Android, iOS, Windows, Web) |
| Local offline DB | SQLite (`sqlite3`) with Drift-equivalent schema (`cached_products`, `cart_lines`, `local_inventory`, `sync_events`) |
| Sync | Outbox queue (`sync_events`) → `POST /sync/events` |
| API | NestJS (TypeScript) |
| Database (next) | PostgreSQL |
| Cache/jobs (next) | Redis |
| Files (next) | S3-compatible |
| Payments (next) | Stripe |

### Offline model

- **Works offline:** cached catalogue, cart edits, supplier inventory receive (+delta), queued sync
- **Needs online:** final payment charge, payouts, live tracking
- Top bar shows `API: Online/Offline` and `Sync N` pending events
- Supplier → Products → **Receive +20** writes SQLite immediately and syncs when the API is back

## Repo layout

```
apps/
  winger/   # Flutter UI
  api/      # NestJS API
design/     # Figma/export references
docker-compose.yml
```

## Run locally

### 1. Database (PostgreSQL)

**Option A — embedded Postgres (no Docker):**

```bash
cd apps/api
npm run db:pg          # keep this terminal open (port 5433)
# new terminal:
npm run db:setup       # migrate + seed
```

**Option B — Docker:**

```bash
docker compose up -d postgres
# set DATABASE_URL to port 5432 in apps/api/.env
cd apps/api
npm run db:setup
```

### 2. API

```bash
cd apps/api
npm run start:dev
```

API: `http://localhost:3000`  
Health: `GET /health`  
Products: `GET /products` · `GET /products/:id` (from Postgres)  
Sync: `POST /sync/events` · `GET /sync/events` (inventory deltas applied in Postgres)

The Flutter app falls back to local SQLite cache if the API is offline.

### 2. Flutter UI

```bash
cd apps/winger
flutter pub get
flutter run -d chrome
# or: flutter run -d windows
```

> **Note:** If Windows/native builds fail with `'C:\Users\...\S3' is not recognized`, your Flutter SDK is installed under a path with spaces (e.g. `S3 POS+`). Reinstall or point `PATH` to a Flutter SDK under a path without spaces, such as `C:\src\flutter`.

### Demo login

Password for all seeded users: `demo1234`

| Role | Email |
|------|-------|
| Customer | `amina.mwangi@example.com` |
| Supplier (Kijani Tech) | `supplier@kijani.example` |
| Admin | `admin@winger.example` |

Pick the matching role on login. The app calls `POST /auth/login`, stores a JWT, and sends it on sync.

1. **Customer** — marketplace → product → cart → checkout (`POST /orders`) → tracking  
2. **Supplier** — orders (paid lines) / products / **Receive +20** (role-scoped sync)  
3. **Admin** — dashboard / suppliers / orders / delivery  

Checkout charges via **demo payment** unless `STRIPE_SECRET_KEY` is set in `apps/api/.env` (Stripe test key auto-confirms with `pm_card_visa`).

Language switcher: English · Español · Kiswahili

### Optional infrastructure

Docker Desktop is required for compose:

```bash
docker compose up -d
```

Local demo uses embedded Postgres on `5433` (see `npm run db:pg` in `apps/api`).

## Design reference

Figma: https://www.figma.com/design/QkxZ4XWlySnPvl6xQmN5Mz/Winger-Design  
Local exports live under `design/` and `Downloads/Winger Design/`.
