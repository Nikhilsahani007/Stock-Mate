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

## Stock and billing

Documents are what people write; posting derives two append-only ledgers from them.

- **Documents**: purchase, sale, opening stock, adjustment, transfer, expense, customer
  receipt, supplier payment. Each type posts through one function in `apps/api/src/posting/`
  inside a single database transaction. Numbers are gap-free per branch, type and Indian
  fiscal year (`INV/2026-27/0001`).
- **Stock ledger** (`StockMovement`, one row per IMEI for phones) and **stock balances**
  (`StockBalance`, quantity and value per variant per branch). Balances are locked with
  `SELECT ... FOR UPDATE` in sorted order, then devices, then the number series, so
  concurrent postings neither deadlock nor oversell.
- **Money ledger** (`LedgerEntry`): double entry against a small fixed chart of accounts.
  Every document's entries must balance or nothing is written.
- **Stock never goes negative**, for phones or accessories. The API refuses with
  `409 INSUFFICIENT_STOCK`, and a database `CHECK` backs it up.
- **Costing**: phones and other IMEI-tracked items use specific identification (each
  device carries its own cost). Accessories use a moving weighted average per branch.
  Freight on a purchase is spread over its lines by value. Each sale line records a cost
  confidence: verified (from a purchase), estimated (typed in as opening stock) or unknown.
- **GST is optional per branch.** A GST branch issues tax invoices (CGST + SGST within the
  state, IGST across states, by the party's GSTIN state code) and claims input credit on
  purchases. A non-GST branch issues plain bills and its purchase GST becomes part of cost.
  Sale prices default to GST-inclusive (MRP style); invoices round to the rupee with a
  separate round-off.
- **Transfers** go out at the sending branch's cost into stock in transit and are added to
  the receiving branch's average when it receives them.
- **Corrections**: posted documents are never edited. Cancel appends an exact reversal on
  the original date. Accessories that came in are taken back out at today's average, with
  any difference booked as price variance. A device that has since moved on (sold,
  transferred) blocks the cancel.
- **Retries are safe**: send an `Idempotency-Key` header and a repeated request returns
  the original document instead of posting twice. The web app does this on every save.
- **Costs are private**: roles without `cost.view` (cashiers) never receive cost or stock
  value fields from the API.

Not in this phase yet: sale and purchase returns, backdated cost replay, month locking,
reports and day close (Phase 3).

## Money

Amounts are integer paise. Rounding is half away from zero, applied once per line.
See `packages/shared/src/money.ts`.
