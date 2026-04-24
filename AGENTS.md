# AGENTS.md — AI Agent Instructions for Time-Off Microservice

## Project Overview

This is the **Time-Off Microservice** for ReadyOn/Wizdaa.
It manages leave balance lifecycle synced with an external HCM system (Workday/SAP).

**Stack**: NestJS · SQLite (TypeORM) · TypeScript strict mode  
**Key patterns**: Optimistic locking · State machine · Idempotency · HMAC webhooks · JWT RBAC

---

## Mandatory Rules — Follow These Without Exception

### 1. Never Break the State Machine
File: `src/modules/requests/state-machine.ts`

Every status change on a `TimeOffRequest` MUST call `validateTransition(from, to)` first.
Valid transitions:
```
DRAFT → PENDING → APPROVED  (terminal)
DRAFT → CANCELLED            (terminal)
PENDING → REJECTED           (terminal)
PENDING → CANCELLED          (terminal)
```
Never bypass this. Never write raw SQL to update status directly.

### 2. Optimistic Lock on Every Balance Update
File: `src/modules/balances/balances.service.ts` → `deductDays()`

All balance deductions MUST use the pattern:
```sql
UPDATE leave_balances
SET used_days = used_days + ?, version = version + 1
WHERE id = ? AND version = ?
```
If `rowsAffected === 0` → retry up to 3 times with exponential backoff → throw `ConflictException`.
Never update `used_days` without the `version` check.

### 3. Always Pre-Validate Locally Before Calling HCM
In `RequestsService.create()`, the local balance check MUST happen before any HCM call.
HCM errors may be silent — our local check is the last line of defense.

### 4. Idempotency Key Always Checked First
In any write endpoint, check the `idempotency_key` column BEFORE creating a new record.
Return the existing record if the key already exists.

### 5. Audit Log Every State Change
Use `AuditService.log()` after every:
- Balance deduction or restoration
- Request status change
- User role/manager change

`AuditService.log()` never throws — it swallows errors intentionally. Do not wrap it in try/catch.

### 6. HCM Calls Always Through HcmAdapter
Never call `fetch()` directly for HCM endpoints. Always use `HcmAdapter`.
`HcmAdapter` handles: retry with backoff · per-request timeout · domain error translation.

### 7. Webhook HMAC Must Be Verified
`WebhooksController` uses `crypto.timingSafeEqual()` for signature comparison.
Never use `===` for comparing HMAC signatures (timing attack vulnerability).
Always reject webhooks older than 5 minutes (replay attack prevention).

### 8. Role Enforcement
- `EMPLOYEE`: read/create own requests, read own balances
- `MANAGER`: approve/reject requests (only for their explicitly linked employees via `manager_id` FK)
- `ADMIN`: everything + batch sync + audit logs

The `isManagerOf()` check in `UsersService` is mandatory before any approve/reject action.

### 9. No Raw SQL Strings
Use TypeORM repository pattern everywhere.
The only exceptions are the optimistic lock UPDATE and the balance restore — these are
parameterized queries with `?` placeholders, never string interpolation.

### 10. Test Coverage Must Not Drop
- Unit tests: `test/unit/`
- Integration tests: `test/integration/`
- Coverage threshold: 80% lines, 80% functions, 75% branches
- Run before every commit: `npm run test:cov`
- Never remove or skip existing tests

---

## File Map

| Concern | File |
|---|---|
| State machine | `src/modules/requests/state-machine.ts` |
| Optimistic lock | `src/modules/balances/balances.service.ts` |
| HCM adapter | `src/infrastructure/hcm/hcm.adapter.ts` |
| JWT strategy | `src/modules/auth/strategies/jwt.strategy.ts` |
| Webhook HMAC | `src/modules/webhooks/webhooks.controller.ts` |
| Audit log | `src/modules/audit/audit.service.ts` |
| Config (all env vars) | `src/config/configuration.ts` |
| Mock HCM server | `mock-hcm/server.ts` |

---

## Environment Variables

All config goes through `src/config/configuration.ts`. Never read `process.env` directly in services.
Use `ConfigService.get<T>('nested.key')` everywhere.

Required env vars (see `.env.example`):
- `JWT_SECRET` — min 32 chars
- `HCM_WEBHOOK_SECRET` — min 32 chars
- `HCM_BASE_URL` — URL of HCM server
- `DB_PATH` — SQLite file path

---

## Running the Project

```bash
# Start main service
npm run start:dev

# Start mock HCM server (separate terminal)
cd mock-hcm && npx ts-node server.ts

# Run all tests
npm test

# Run with coverage
npm run test:cov
```

---

## Integration Test Patterns

### Mocking External Services (HCM) in NestJS Tests

Never rely on an external Mock HCM server process. Instead, override `HcmAdapter` at test bootstrap:

```typescript
const MockHcmAdapter = {
  getBalance: jest.fn().mockResolvedValue({ availableDays: 30 }),
  fileRequest: jest.fn().mockResolvedValue({ hcmRequestId: 'HCM-TEST', status: 'PENDING_APPROVAL' }),
  ingestBatch: jest.fn().mockResolvedValue({ accepted: 0 }),
  ping: jest.fn().mockResolvedValue(true),
};

const module = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(HcmAdapter)
  .useValue(MockHcmAdapter)
  .compile();
```

This gives you deterministic, fast tests without external dependencies.

### Test Isolation Rules

1. **Each test file gets its own app instance** — call `buildTestApp()` in `beforeAll` once per `describe` block
2. **Use `:memory:` SQLite database** — never share DB across test files
3. **Seed data AFTER app init, BEFORE token generation** — order matters
4. **No global state** — each test must be self-contained

### JWT Token Generation Pattern

Sign tokens AFTER all DB updates are complete, using the exact `id` stored in the DB:

```typescript
employeeToken = jwtService.sign({
  sub: employeeId,     // must match the DB row's id exactly
  email: 'employee@test.com',
  role: UserRole.EMPLOYEE,
});
```

### Manager Linkage Order

Correct ordering is critical:

```typescript
// 1. Create manager first
const managerRes = await request(app).post('/auth/register').send({ email: 'manager@test.com', ... });
const managerId = managerRes.body.data.user.id;
await dataSource.query(`UPDATE users SET role = 'MANAGER' WHERE id = ?`, [managerId]);

// 2. Create employee
const employeeRes = await request(app).post('/auth/register').send({ email: 'employee@test.com', ... });
const dbEmployeeId = employeeRes.body.data.user.id;

// 3. Link employee to manager using the actual DB id
await dataSource.query(
  `UPDATE users SET id = 'emp-001', manager_id = ? WHERE id = ?`,
  [managerId, dbEmployeeId],
);
const employeeId = 'emp-001';

// 4. Now sign token
employeeToken = jwtService.sign({ sub: employeeId, ... });
```

### Webhook HMAC Signature Pattern

The signature must match the controller's format exactly:

```typescript
const timestamp = Date.now();
const body = JSON.stringify(payload);  // pre-stringify
const sig = crypto
  .createHmac('sha256', process.env.HCM_WEBHOOK_SECRET)
  .update(`${timestamp}.${body}`)
  .digest('hex');

await request(app)
  .post('/api/v1/webhooks/hcm/balance-update')
  .set('X-HCM-Signature', sig)
  .set('X-HCM-Timestamp', String(timestamp))
  .send(body);  // send as string
```

Key points:
- Use `X-HCM-Timestamp` header (not `X-HCM-Timestamp`)
- Pre-stringify body with `JSON.stringify()` before sending
- Verify timestamp freshness — reject if older than 5 minutes

### Balance Seeding for Request Creation Tests

Seed sufficient balance so local checks always pass:

```typescript
await dataSource.query(
  `INSERT INTO leave_balances (id, employee_id, location_id, leave_type, total_days, used_days, version, hcm_synced, last_synced_at, created_at, updated_at)
   VALUES ('bal-test-1', ?, 'loc-NYC', 'ANNUAL', 30, 0, 1, 1, datetime('now'), datetime('now'), datetime('now'))`,
  [employeeId],
);
```

Use `total_days: 30, used_days: 0` to ensure `availableDays >= any daysRequested` in tests.

### State Transition Testing

Always test invalid transitions:

```typescript
it('rejects re-approving an already-approved request', async () => {
  const res = await request(app)
    .patch(`/requests/${requestId}/approve`)
    .set('Authorization', `Bearer ${managerToken}`)
    .send({});
  expect(res.status).toBe(422);  // UnprocessableEntityException
});
```

The state machine (`state-machine.ts`) defines terminal states — REJECTED, APPROVED, and CANCELLED cannot transition further.

### Preventing Requests from Becoming REJECTED

The root cause of requests becoming REJECTED is the HCM call after local balance deduction. If HCM fails:
1. Balance is restored
2. Status is overwritten to REJECTED

To prevent this in tests:
- Override `HcmAdapter` to always return success
- Or seed the mock with employee IDs matching the in-memory seed (`emp-001`, `emp-002`, etc.)

---

## Quick Test Checklist

Before every commit, verify:
- [ ] `npm test` passes
- [ ] `npm run test:cov` meets thresholds
- [ ] No external process required (mock HcmAdapter)
- [ ] JWT tokens use correct `sub` claim
- [ ] Manager linkage uses correct FK ordering
- [ ] Webhook signatures use pre-stringified body
