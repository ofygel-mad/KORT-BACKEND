# Kort Server — Architecture

Backend for the Kort ERP/CRM system. Serves the React SPA frontend.

## Tech Stack

- **Runtime**: Node.js + TypeScript (ESM)
- **Framework**: Fastify 5
- **ORM**: Prisma (PostgreSQL)
- **Auth**: JWT (access + refresh tokens, rotation on refresh)
- **Validation**: Zod
- **Password hashing**: bcryptjs

## Directory Structure

```
server/
├── prisma/
│   ├── schema.prisma            # Database schema (28 tables)
│   └── seed.ts                  # Demo data seeder
├── src/
│   ├── index.ts                 # Entry point — starts Fastify on :8000
│   ├── app.ts                   # App factory — registers plugins, routes, error handler
│   ├── config.ts                # Env validation via Zod (DATABASE_URL, JWT secrets, etc.)
│   ├── lib/                     # Shared utilities (no business logic)
│   │   ├── prisma.ts            # Prisma client singleton + connect/disconnect
│   │   ├── jwt.ts               # signAccessToken, signRefreshToken, verify*
│   │   ├── hash.ts              # hashPassword, verifyPassword (bcrypt)
│   │   ├── errors.ts            # AppError hierarchy (NotFound, Forbidden, etc.)
│   │   └── pagination.ts        # paginate(), paginatedResponse() + Zod schema
│   ├── plugins/                 # Fastify plugins (decorators on request/instance)
│   │   ├── auth.ts              # authenticate / optionalAuth → sets request.userId
│   │   └── org-scope.ts         # resolveOrg → sets request.orgId, orgRole
│   ├── types/
│   │   └── fastify.d.ts         # FastifyRequest augmentation (userId, orgId, etc.)
│   └── modules/                 # Feature modules (each has routes + service)
│       ├── auth/
│       ├── users/
│       ├── orgs/
│       ├── memberships/
│       ├── customers/
│       ├── leads/
│       ├── deals/
│       ├── tasks/
│       └── chapan/
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

## Module Pattern

Every module follows the same pattern:

- `<module>.routes.ts` — Fastify route definitions. Handles HTTP layer: parsing params/body with Zod, calling service, returning response. No business logic here.
- `<module>.service.ts` — Business logic. Calls Prisma directly. Throws `AppError` subclasses on failures. Returns plain objects (no Fastify coupling).

This separation means services can be reused (e.g. from a future CLI, background jobs, or tests) without importing Fastify.

## Authentication & Authorization Flow

Every protected request goes through a preHandler chain:

```
request
  → authenticate         (plugins/auth.ts)      — verifies JWT, sets request.userId
  → resolveOrg           (plugins/org-scope.ts)  — finds active membership, sets request.orgId + orgRole
  → requireRole(...)     (plugins/org-scope.ts)  — checks orgRole against required minimum
  → route handler
```

### Roles (global, per-org membership)

| Role    | Level | Can do |
|---------|-------|--------|
| owner   | 4     | Everything + billing |
| admin   | 3     | Everything except billing |
| manager | 2     | Core CRM features |
| viewer  | 1     | Read-only |

### Token Flow

- Login/register returns `{ access, refresh }`.
- Access token: short-lived (15m default), contains `{ sub: userId, email }`.
- Refresh token: long-lived (7d), stored in DB. On refresh, old token is deleted and new pair is issued (rotation).
- Frontend sends `Authorization: Bearer <access>` on every request.
- On 401, frontend calls `POST /api/v1/auth/token/refresh` with the refresh token.

## Multitenancy

All data is scoped to an organization (`orgId`). The `resolveOrg` plugin reads the user's active membership and injects `orgId` into the request. Every service method takes `orgId` as its first parameter and includes it in all Prisma queries. There is no way to access another org's data.

## API Endpoints

All endpoints are prefixed with `/api/v1`.

### Auth (`/auth`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | No | Login with email + password |
| POST | `/auth/register/employee` | No | Register as employee (optionally with invite token) |
| POST | `/auth/register/company` | No | Register + create new organization |
| POST | `/auth/token/refresh` | No | Exchange refresh token for new pair |
| GET | `/auth/bootstrap` | Optional | Get current session (user, org, role, capabilities) |
| GET | `/auth/me` | Optional | Alias for bootstrap |

### Users (`/users`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users/me` | Yes | Get current user profile |
| GET | `/users/team` | Yes+Org | List team members in current org |
| PATCH | `/users/:id/role` | Admin+ | Change a member's role |
| POST | `/users/:id/activate` | Admin+ | Activate a user account |
| POST | `/users/:id/deactivate` | Admin+ | Deactivate a user account |

### Organization

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/organization` | Yes+Org | Get current org details |
| PATCH | `/organization` | Admin+ | Update org settings |
| GET | `/companies/search?q=` | No | Search orgs by name/slug |

### Memberships & Invites

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/membership-requests` | Yes | Submit request to join an org |
| GET | `/membership-requests/me` | Yes | List own membership requests |
| GET | `/admin/membership-requests` | Admin+ | List pending requests for the org |
| POST | `/admin/membership-requests/:id/approve` | Admin+ | Approve a request |
| POST | `/admin/membership-requests/:id/reject` | Admin+ | Reject a request |
| POST | `/admin/invites` | Admin+ | Create an invite link |
| GET | `/admin/invites` | Admin+ | List invites for the org |
| GET | `/invites/:token` | No | Get invite details by token |

### CRM: Customers (`/customers`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/customers?page=&limit=` | Yes+Org | Paginated customer list |
| GET | `/customers/:id` | Yes+Org | Get customer by ID |
| POST | `/customers` | Yes+Org | Create customer |
| PATCH | `/customers/:id` | Yes+Org | Update customer |

### CRM: Leads (`/leads`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/leads?pipeline=&stage=&page=&limit=` | Yes+Org | Filtered/paginated leads |
| GET | `/leads/:id` | Yes+Org | Get lead with history |
| POST | `/leads` | Yes+Org | Create lead |
| PATCH | `/leads/:id` | Yes+Org | Update lead (auto-logs stage changes) |
| POST | `/leads/:id/history` | Yes+Org | Add history entry (comment, note) |
| POST | `/leads/:id/checklist` | Yes+Org | Toggle checklist item { itemId, done } |

### CRM: Deals (`/deals`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/deals?page=&limit=` | Yes+Org | Paginated deals |
| GET | `/deals/:id` | Yes+Org | Get deal with activities + tasks |
| POST | `/deals` | Yes+Org | Create deal |
| PATCH | `/deals/:id` | Yes+Org | Update deal (auto-logs stage changes) |
| POST | `/deals/:id/activities` | Yes+Org | Add activity (note, call, etc.) |
| DELETE | `/deals/:id` | Yes+Org | Delete deal |

### CRM: Tasks (`/tasks`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/tasks?status=&priority=&page=&limit=` | Yes+Org | Filtered/paginated tasks (with subtasks + activities) |
| GET | `/tasks/:id` | Yes+Org | Get task with subtasks + activities |
| POST | `/tasks` | Yes+Org | Create task (auto-creates system activity) |
| PATCH | `/tasks/:id` | Yes+Org | Update task fields |
| PATCH | `/tasks/:id/status` | Yes+Org | Move task status (auto-logs, auto-sets completedAt) |
| POST | `/tasks/:id/subtasks` | Yes+Org | Add subtask |
| PATCH | `/tasks/:id/subtasks/:subtaskId` | Yes+Org | Toggle subtask done |
| POST | `/tasks/:id/activities` | Yes+Org | Add activity (comment, etc.) |
| DELETE | `/tasks/:id` | Yes+Org | Delete task |

### Chapan: Orders (`/chapan/orders`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/chapan/orders?status=&priority=&paymentStatus=&search=&sortBy=` | Yes+Org | List orders with filters |
| GET | `/chapan/orders/:id` | Yes+Org | Get order with items, tasks, payments, activities |
| POST | `/chapan/orders` | Yes+Org | Create order (auto-calculates totalAmount) |
| POST | `/chapan/orders/:id/confirm` | Yes+Org | Confirm order (auto-creates production tasks from items) |
| PATCH | `/chapan/orders/:id/status` | Yes+Org | Change order status |
| POST | `/chapan/orders/:id/payments` | Yes+Org | Add payment (auto-updates paymentStatus) |
| POST | `/chapan/orders/:id/transfer` | Yes+Org | Initiate transfer |
| POST | `/chapan/orders/:id/transfer/confirm` | Yes+Org | Confirm transfer (by: manager or client) |
| POST | `/chapan/orders/:id/activities` | Yes+Org | Add comment/activity |

### Chapan: Production (`/chapan/production`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/chapan/production?status=&assignedTo=` | Yes+Org | List all production tasks (manager view, includes client data) |
| GET | `/chapan/production/workshop` | Yes+Org | Workshop view (NO client names/phones — privacy) |
| PATCH | `/chapan/production/:id/status` | Yes+Org | Move task status (auto-sets order to "ready" when all tasks done) |
| PATCH | `/chapan/production/:id/assign` | Yes+Org | Assign worker to task |
| POST | `/chapan/production/:id/flag` | Yes+Org | Block task with reason |
| POST | `/chapan/production/:id/unflag` | Yes+Org | Unblock task |
| PATCH | `/chapan/production/:id/defect` | Yes+Org | Set/clear defect note |

### Chapan: Requests (`/chapan/requests`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/chapan/requests?status=` | Yes+Org | List client requests |
| POST | `/chapan/requests` | Yes+Org | Submit request internally (from manager) |
| PATCH | `/chapan/requests/:id/status` | Yes+Org | Update request status |
| POST | `/chapan/requests/public/:orgId` | **No** | Public form submission (no auth) |
| GET | `/chapan/requests/public/:orgId/profile` | **No** | Get public form config + catalogs |

### Chapan: Settings (`/chapan/settings`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/chapan/settings/profile` | Yes+Org | Get workshop profile |
| PATCH | `/chapan/settings/profile` | Admin+ | Update workshop profile |
| GET | `/chapan/settings/catalogs` | Yes+Org | Get catalogs (products, fabrics, sizes, workers) |
| PUT | `/chapan/settings/catalogs` | Admin+ | Replace catalogs |
| GET | `/chapan/settings/clients` | Yes+Org | List chapan clients |
| POST | `/chapan/settings/clients` | Yes+Org | Create chapan client |

### Utility

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |

## Database Schema Overview

### Identity & Access (5 tables)

- `users` — user accounts (email, password hash, status)
- `refresh_tokens` — stored refresh tokens (for rotation/revocation)
- `organizations` — companies/workspaces
- `memberships` — user ↔ org link with role + status
- `invites` — invite tokens for joining an org
- `membership_requests` — pending join requests

### CRM (6 tables)

- `customers` — contacts (scoped to org)
- `leads` — sales leads with pipeline/stage
- `lead_history` — audit trail for lead changes
- `deals` — deals with stage, value, probability
- `deal_activities` — deal event log
- `tasks` — to-do items, optionally linked to deals

### Chapan Workshop (17 tables)

- `chapan_profiles` — per-org workshop settings (name, prefix, counters, public form config)
- `chapan_clients` — workshop-specific client records
- `chapan_orders` — orders with status/payment/priority axes
- `chapan_order_items` — line items (product, fabric, size, quantity, price)
- `chapan_production_tasks` — 1:1 with order items, tracks production pipeline
- `chapan_payments` — payment records per order
- `chapan_transfers` — two-party handoff confirmation
- `chapan_activities` — full audit log with author
- `chapan_requests` — client intake requests (from public form or internal)
- `chapan_request_items` — items within a request
- `chapan_workers` — worker names (per-org catalog)
- `chapan_catalog_products` — product catalog
- `chapan_catalog_fabrics` — fabric catalog
- `chapan_catalog_sizes` — size catalog

## Key Behaviors

### Order Lifecycle

```
new → confirmed → in_production → ready → transferred → completed
                                       ↘ cancelled
```

- **Confirm** auto-creates `chapan_production_tasks` from `chapan_order_items`.
- **All tasks done** → order auto-transitions to `ready`.
- **Transfer** requires both manager + client confirmation.

### Production Pipeline (per task)

```
pending → cutting → sewing → finishing → quality_check → done
```

Tasks can be blocked/unblocked with a reason at any stage.

### Payment Tracking

- Each payment is a separate record.
- `paidAmount` is accumulated. `paymentStatus` auto-computed: `not_paid | partial | paid`.

### Data Isolation (Workshop Console)

The `/chapan/production/workshop` endpoint returns tasks **without** `clientName` and `clientPhone`. This is the endpoint used by workshop_lead/worker roles who should not see client PII.

### Activity Log

Every significant action (status change, payment, production update, comment, transfer) creates a `chapan_activities` record with `authorId` + `authorName`. No more hardcoded "Менеджер".

## Running

```bash
cd server
cp .env.example .env              # configure DATABASE_URL and JWT secrets
npm install
npx prisma migrate dev             # create tables
npm run db:seed                    # seed demo data
npm run dev                        # start dev server on :8000
```

The frontend Vite dev server proxies `/api/*` → `http://localhost:8000` (configured in `vite.config.ts`). To switch from mock to real backend, set `VITE_MOCK_API=false` in the frontend `.env.local`.

## Demo Accounts

All passwords: `demo1234`

| Email | Role | Purpose |
|-------|------|---------|
| admin@kort.local | owner | Full access |
| manager@kort.local | admin | Manager access |
| lead@kort.local | manager | Workshop lead |
| worker@kort.local | manager | Workshop worker |
| viewer@kort.local | viewer | Read-only |

## Extending

To add a new module:

1. Create `src/modules/<name>/<name>.service.ts` — business logic
2. Create `src/modules/<name>/<name>.routes.ts` — Fastify routes
3. Register in `src/app.ts` with `app.register(routes, { prefix: '/api/v1/<name>' })`
4. Add Prisma models to `prisma/schema.prisma`, run `npx prisma migrate dev`

The module pattern (routes ↔ service ↔ Prisma) keeps each feature self-contained. Services never import Fastify, routes never import Prisma directly.
