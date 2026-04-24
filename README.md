# Time-Off Microservice

A production-grade time-off management microservice built with **NestJS** and **SQLite**, featuring real-time HCM synchronization, optimistic locking, idempotent request handling, and HMAC-secured webhooks.

---

## Features

- **JWT Authentication** — Real bcrypt-hashed passwords, role-based access (EMPLOYEE / MANAGER / ADMIN)
- **Leave Balance Management** — Optimistic locking prevents double-booking under concurrent load
- **Request Lifecycle** — State machine: DRAFT → PENDING → APPROVED / REJECTED / CANCELLED
- **HCM Sync** — Hybrid: pull-on-stale (real-time) + batch ingestion + inbound webhook push
- **Idempotency** — `X-Idempotency-Key` header prevents duplicate submissions from retries
- **Webhook Security** — HMAC-SHA256 signature + 5-minute replay attack window
- **Audit Trail** — Immutable log of every balance change and status transition
- **Mock HCM Server** — Standalone Express server for local development and testing

---

## Prerequisites

- Node.js 20+
- npm 9+

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/MrGranday/time-off-microservice.git
cd time-off-microservice
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set strong secrets:

```env
JWT_SECRET=your-strong-secret-minimum-32-characters
HCM_WEBHOOK_SECRET=your-webhook-secret-minimum-32-characters
HCM_BASE_URL=http://localhost:4000
```

### 3. Create the data directory

```bash
mkdir data
```

### 4. Start the Mock HCM Server (Terminal 1)

```bash
cd mock-hcm
npm install
npx ts-node server.ts
```

The mock HCM will start at `http://localhost:4000`.

### 5. Start the Microservice (Terminal 2)

```bash
npm run start:dev
```

The API will be available at `http://localhost:3000/api/v1`.

---

## API Usage

### Register & Login

```bash
# Register
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"employee@test.com","name":"Test Employee","password":"password123"}'

# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"employee@test.com","password":"password123"}'
```

### Create a Time-Off Request

```bash
curl -X POST http://localhost:3000/api/v1/requests \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: unique-key-123" \
  -d '{
    "locationId": "loc-NYC",
    "leaveType": "ANNUAL",
    "startDate": "2025-07-01",
    "endDate": "2025-07-03",
    "daysRequested": 3,
    "reason": "Summer vacation"
  }'
```

### View Balances

```bash
curl http://localhost:3000/api/v1/balances/<employeeId> \
  -H "Authorization: Bearer <TOKEN>"
```

---

## Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only (requires Mock HCM running on port 4000)
npm run test:integration

# Tests with coverage report
npm run test:cov
```

## Test Results & Coverage

**82 tests, 8 suites — all passing.**

```
Test Suites: 8 passed, 8 total
Tests:       82 passed, 82 total

 Unit Tests (64 tests)
  ✓ state-machine.spec.ts       — 10 tests
  ✓ balances.service.spec.ts    — 13 tests
  ✓ sync.service.spec.ts        —  9 tests
  ✓ auth.service.spec.ts        —  7 tests
  ✓ users.service.spec.ts       — 16 tests
  ✓ hcm.adapter.spec.ts         —  9 tests

 Integration Tests (18 tests)
  ✓ request-lifecycle.spec.ts   — 11 tests
  ✓ webhooks-and-sync.spec.ts   —  7 tests
```

**Coverage summary (`npm run test:cov`):**

```
File                         | % Stmts | % Branch | % Funcs | % Lines
-----------------------------|---------|----------|---------|--------
All files                    |   85.83 |    74.14 |   69.02 |   86.06
 auth.service.ts             |  100.00 |    81.81 |  100.00 |  100.00
 auth.controller.ts          |   90.90 |    75.00 |   66.66 |   88.88
 jwt.strategy.ts             |   93.33 |    75.00 |  100.00 |   92.30
 balances.service.ts         |   80.59 |    82.35 |   63.63 |   81.35
 balances.controller.ts      |   80.00 |    76.92 |   60.00 |   78.26
 requests.service.ts         |   81.08 |    65.62 |   85.71 |   83.01
 requests.controller.ts      |   88.00 |    66.66 |   71.42 |   86.95
 state-machine.ts            |  100.00 |    87.50 |  100.00 |  100.00
 sync.service.ts             |   95.65 |    80.00 |   80.00 |   95.45
 sync.controller.ts          |   96.15 |    75.00 |   75.00 |   95.83
 webhooks.controller.ts      |  100.00 |    80.76 |  100.00 |  100.00
 jwt-auth.guard.ts           |  100.00 |    87.50 |  100.00 |  100.00
 roles.guard.ts              |  100.00 |    91.66 |  100.00 |  100.00
 users.service.ts            |  100.00 |    93.33 |  100.00 |  100.00
 users.controller.ts         |   73.07 |    75.00 |   12.50 |   70.83
 hcm.adapter.ts              |   98.14 |    85.00 |   90.90 |  100.00
```

Coverage reports are written to `./coverage/`. Open `coverage/index.html` in a browser.

---

## Project Structure

```
src/
├── config/             # Typed environment configuration
├── common/             # Guards, decorators, filters, interceptors
├── modules/
│   ├── auth/           # JWT auth, bcrypt, login/register
│   ├── users/          # User management, manager-employee links
│   ├── balances/       # Balance read/sync with optimistic locking
│   ├── requests/       # Request lifecycle + state machine
│   ├── sync/           # Realtime & batch HCM sync
│   ├── webhooks/       # HMAC-verified inbound HCM events
│   ├── audit/          # Immutable audit trail
│   └── health/         # Liveness & readiness probes
└── infrastructure/
    └── hcm/            # HCM adapter (retry, timeout, error translation)

mock-hcm/               # Standalone mock HCM server
test/
├── unit/               # Pure unit tests (mocked dependencies)
└── integration/        # Full-stack tests with in-memory SQLite
docs/
└── TRD.md              # Technical Requirements Document
```

---

## Security Notes

- Passwords are hashed with bcrypt (cost factor 12)
- JWT tokens validated on every request with live DB user lookup
- Webhook payloads verified with HMAC-SHA256 using `crypto.timingSafeEqual()`
- All endpoints protected with Helmet security headers
- Rate limited to 100 req/min per IP
- Input validation with `class-validator` — unknown properties rejected (403)

---

## CI/CD

GitHub Actions runs automatically on every push to `main` or `develop`:

1. **Lint** — ESLint check
2. **Unit Tests** — with coverage report artifact
3. **Integration Tests** — spins up mock HCM, runs full lifecycle tests
4. **Build** — TypeScript compile check

See `.github/workflows/ci.yml`.
