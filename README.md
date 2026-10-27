# StockPilot

Multi-tenant inventory, billing and reporting for Indian mobile phone and accessory retailers.

This repository is a pnpm + Turborepo monorepo:

| Path | What it is |
|---|---|
| `apps/api` | Express + TypeScript API, PostgreSQL via Prisma |
| `apps/web` | React + Vite web app (plain CSS, no Tailwind) |
| `packages/shared` | Roles and permissions, Zod schemas, money helpers, plans and trial rules shared by both |

## Getting started

Requirements: Node 22, pnpm 10, PostgreSQL 16 (or Docker).

```bash
docker compose up -d                # Postgres with stockpilot and stockpilot_test databases
cp apps/api/.env.example apps/api/.env
pnpm install
pnpm db:migrate                     # apply migrations to the dev database
pnpm dev                            # API on :4000, web on :5173 (proxies /api)
```

Run the checks CI runs:

```bash
pnpm typecheck && pnpm build && pnpm test
```

API tests run against a real Postgres database (`TEST_DATABASE_URL`, default
`postgresql://stockpilot:stockpilot@localhost:5432/stockpilot_test`).

## How tenancy and access work

- Every tenant-owned row has a `businessId`. Business routes live under
  `/api/businesses/:businessId/...`, and `loadTenant` resolves that ID only through
  the signed-in user's own membership. Anyone without one gets **404**, so other
  businesses' IDs reveal nothing.
- Lookups by ID always also filter by `businessId`. Join tables reference parents by
  `(id, businessId)`, so Postgres itself refuses to link a member to another
  business's branch.
- Roles and permissions are defined once in `packages/shared/src/roles.ts` and enforced
  by the API. Owners and admins see all branches; other roles see only branches assigned
  to them.
- Sessions are opaque random tokens; only their SHA-256 hash is stored. The web app uses
  an `httpOnly` cookie plus a required `X-StockPilot-Client` header on writes (CSRF
  defence); the desktop app can send `Authorization: Bearer <token>`. Sessions can be
  revoked individually or all at once.
- Passwords are hashed with argon2id. Auth routes are rate limited.
- Important actions are written to `AuditLog` in the same transaction as the change.

## Trial

Each new business gets 14 days of full access, then 3 days of grace, then read-only
(writes return `402 TRIAL_EXPIRED`), then the account is archived 90 days later. The
rules live in `computeAccess` in `packages/shared/src/plans.ts`.

## Money

Amounts are integer paise. Rounding is half away from zero, applied once per line.
See `packages/shared/src/money.ts`.
