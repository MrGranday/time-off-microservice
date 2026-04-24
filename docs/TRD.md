# Technical Requirements Document (TRD)
# Time-Off Microservice — ReadyOn / Wizdaa

**Author**: Osman  
**Version**: 1.0  
**Date**: April 2025  
**Stack**: NestJS · SQLite · TypeScript

---

## 1. Problem Statement

ReadyOn (also referred to as ExampleHR) serves as the primary UI for employees to request time off. However, the HCM system (Workday/SAP) is the **source of truth** for employment data and leave balances. Keeping two systems synchronized is the central challenge:

- If an employee has 10 days of leave and requests 2 days on ReadyOn/ExampleHR, we must verify the HCM agrees with the balance.
- External processes (e.g., work anniversary bonuses, start of year refreshes) can update the HCM balance independently without ReadyOn knowing.
- HCM's error responses for insufficient balance or invalid dimensions are **not guaranteed** — we must defend against regressions and invalid states locally.
- Race conditions can occur when two requests arrive simultaneously for the same balance.

---

## 2. Goals

1. Manage the full lifecycle of time-off requests (create → approve/reject → cancel).
2. Maintain balance integrity across two systems using a defensive, hybrid sync strategy.
3. Guard against concurrent modification with optimistic locking.
4. Support HCM-initiated balance updates via secure webhooks.
5. Provide a full audit trail for all state changes.
6. Be testable, observable, and secure by default.

---

## 3. Non-Goals

- This service does not manage calendar/shift scheduling.
- It does not handle payroll integration.
- It does not implement real-time UI push (WebSockets) — that is the API consumer's concern.

---

## 4. Architecture

### 4.1 System Components

```
Employee/Manager Client
        │ REST (JWT Bearer)
        ▼
┌──────────────────────────────────┐
│      Time-Off Microservice       │
│  NestJS · Port 3000              │
│                                  │
│  ┌──────────┐  ┌──────────────┐  │
│  │  Auth    │  │   Balances   │  │
│  │  Module  │  │   Module     │  │
│  └──────────┘  └──────────────┘  │
│  ┌──────────┐  ┌──────────────┐  │
│  │ Requests │  │    Sync      │  │
│  │  Module  │  │   Module     │  │
│  └──────────┘  └──────────────┘  │
│  ┌──────────┐  ┌──────────────┐  │
│  │ Webhooks │  │    Audit     │  │
│  │  Module  │  │   Module     │  │
│  └──────────┘  └──────────────┘  │
│                                  │
│         SQLite (TypeORM)         │
└───────────────┬──────────────────┘
                │ HTTP (API Key + Retry + Timeout)
                ▼
        ┌───────────────┐
        │  HCM System   │
        │ (Mock / Real) │
        └───────────────┘
```

### 4.2 Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Balance sync strategy | Hybrid (pull-on-stale + webhook push) | Best balance of freshness vs. HCM load |
| Concurrency control | Optimistic locking (version column) | Non-blocking reads; retries on conflict |
| HCM trust level | Defensive (local pre-check always) | HCM errors not guaranteed |
| Auth | Real JWT (bcrypt + Passport) | Production-grade, no stubs |
| Manager authorization | Explicit FK (manager_id) | Prevents privilege escalation |
| Webhook security | HMAC-SHA256 + replay prevention | Protects against injection and replays |

---

## 5. Data Model

### 5.1 users
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | UUID v4 |
| email | TEXT UNIQUE | Login identifier |
| password | TEXT | bcrypt hash, select:false |
| name | TEXT | Display name |
| role | TEXT | EMPLOYEE / MANAGER / ADMIN |
| manager_id | TEXT FK → users.id | Explicit manager link |
| location_id | TEXT | Default location |
| is_active | BOOLEAN | Soft delete |

### 5.2 leave_balances
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | UUID v4 |
| employee_id | TEXT FK | |
| location_id | TEXT | Balance dimension |
| leave_type | TEXT | ANNUAL / SICK / etc. |
| total_days | REAL | CHECK >= 0 |
| used_days | REAL | CHECK >= 0, <= total_days |
| **version** | INTEGER | **Optimistic lock** |
| last_synced_at | DATETIME | Staleness check |
| hcm_synced | BOOLEAN | |
| UNIQUE | (employee_id, location_id, leave_type) | |

### 5.3 time_off_requests
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | UUID v4 |
| employee_id | TEXT FK | |
| location_id, leave_type | TEXT | Balance dimensions |
| start_date, end_date | TEXT | ISO date YYYY-MM-DD |
| days_requested | REAL | CHECK > 0 |
| status | TEXT | State machine enforced |
| manager_id | TEXT FK | Set on approve/reject |
| approved_by | TEXT | Manager who acted |
| hcm_request_id | TEXT | HCM reference |
| hcm_error | TEXT | Raw HCM error |
| **idempotency_key** | TEXT UNIQUE | Client dedup key |
| version | INTEGER | Optimistic lock |

### 5.4 sync_logs & audit_logs
Immutable append-only tables. Write-only. Never updated after creation.

---

## 6. API Reference

### Authentication
| Endpoint | Auth | Description |
|---|---|---|
| POST /auth/register | None | Create account |
| POST /auth/login | None | Get JWT token |

### Balances
| Endpoint | Auth | Description |
|---|---|---|
| GET /balances/:employeeId | JWT | All balances (own or admin/manager) |
| GET /balances/:employeeId/:locationId/:leaveType | JWT | Specific balance + isStale flag |
| POST /balances/sync/:employeeId | JWT MANAGER/ADMIN | Manual HCM sync |

### Requests
| Endpoint | Auth | Description |
|---|---|---|
| POST /requests | JWT EMPLOYEE | Create request (idempotency key via header) |
| GET /requests | JWT | List (employees see own only) |
| GET /requests/:id | JWT | Get single request |
| PATCH /requests/:id/approve | JWT MANAGER/ADMIN | Approve (must be linked manager) |
| PATCH /requests/:id/reject | JWT MANAGER/ADMIN | Reject + restore balance |
| DELETE /requests/:id | JWT EMPLOYEE | Cancel own PENDING/DRAFT request |

### Sync & Admin
| Endpoint | Auth | Description |
|---|---|---|
| POST /sync/batch | JWT ADMIN | Ingest full HCM corpus |
| GET /sync/logs | JWT ADMIN | Sync operation history |
| GET /audit-logs | JWT ADMIN | Full audit trail |

### Webhooks
| Endpoint | Auth | Description |
|---|---|---|
| POST /webhooks/hcm/balance-update | HMAC | HCM pushes balance changes |

### Health
| Endpoint | Auth | Description |
|---|---|---|
| GET /health | None | Liveness |
| GET /health/ready | None | Readiness (DB + HCM) |

---

## 7. Critical Business Logic

### 7.1 Request Creation Flow
```
1. Check idempotency_key → return existing if found
2. Validate startDate <= endDate
3. Load balance for (employeeId, locationId, leaveType)
4. If balance.lastSyncedAt older than STALE_THRESHOLD_MS → sync from HCM
5. Local check: availableDays >= daysRequested (defensive)
6. Create request record (PENDING)
7. Deduct balance with optimistic lock (retry 3x on conflict)
8. Call HCM to file request
9. If HCM fails → restore balance, mark request REJECTED, store hcm_error
10. Audit log entire operation
```

### 7.2 Balance Deduction (Optimistic Lock)
```sql
UPDATE leave_balances
SET used_days = used_days + ?,
    version = version + 1
WHERE id = ? AND version = ? AND (total_days - used_days) >= ?
```
- 0 rows affected → conflict → retry with 50ms × attempt backoff
- After 3 retries → `ConflictException`

### 7.3 Staleness Detection
- Every balance read checks `lastSyncedAt`
- If `Date.now() - lastSyncedAt > STALE_THRESHOLD_MS` → async refresh
- Response includes `{ isStale: boolean }` flag
- Default threshold: 5 minutes (env: `STALE_THRESHOLD_MS`)

### 7.4 HCM Webhook Processing
```
1. Verify X-HCM-Timestamp not older than 5 min (replay prevention)
2. Compute HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
3. Compare with X-HCM-Signature using timingSafeEqual()
4. If valid → upsert balance (additive, never destructive)
5. Return 200 immediately
```

---

## 8. Security Design

| Threat | Mitigation |
|---|---|
| Unauthenticated access | JWT Bearer on all endpoints except /auth and /health |
| Privilege escalation | RolesGuard + explicit manager_id FK check |
| User enumeration | Identical error for wrong email and wrong password |
| Deactivated user tokens | JwtStrategy does live DB lookup on every request |
| SQL injection | TypeORM parameterized queries throughout |
| Webhook spoofing | HMAC-SHA256 with timing-safe comparison |
| Replay attacks | 5-minute webhook timestamp window |
| XSS / clickjacking | Helmet security headers on all responses |
| Brute force | ThrottlerModule: 100 req/min per IP |
| PII in logs | Password field has `select: false`; never logged |
| Sensitive config | All secrets via env vars, never hardcoded |

---

## 9. Alternatives Considered

### 9.1 Pessimistic Locking vs Optimistic Locking
**Pessimistic**: Row-level locks on reads. Simple but blocks concurrent reads, risk of deadlock.  
**Chosen → Optimistic**: Version column. Non-blocking reads, retry on conflict. Better for read-heavy workloads.

### 9.2 Event Sourcing vs State Machine
**Event sourcing**: Full history stored as events. Powerful but overengineered for this scope.  
**Chosen → State machine**: Simple explicit transitions in `state-machine.ts`. Auditable via audit_logs.

### 9.3 Push vs Pull vs Hybrid Sync
**Pure push**: Real-time but HCM unreliable.  
**Pure pull**: We control timing but adds latency.  
**Chosen → Hybrid**: Pull on stale + webhook push for external mutations (anniversaries, resets).

### 9.4 GraphQL vs REST
**GraphQL**: Flexible queries, good for complex UIs.  
**Chosen → REST**: Simpler to secure, cache, and test. Fits microservice boundaries.

---

## 10. Testing Strategy

| Layer | Tool | Coverage |
|---|---|---|
| Unit | Jest | BalancesService, RequestsService, SyncService, AuthService, StateMachine |
| Integration | Jest + Supertest + in-memory SQLite | Full request lifecycle, idempotency, HMAC, batch sync |
| Mock HCM | Standalone Express (mock-hcm/) | Simulates all HCM endpoints with configurable failure rate |
| CI | GitHub Actions | Runs all tests on every push; fails PR if coverage drops below threshold |

---

## 11. Operational Considerations

- **Database**: SQLite is sufficient for this assessment scope. For production, PostgreSQL is recommended for better concurrency handling and row-level locking.
- **Migrations**: TypeORM `synchronize: true` for dev; migrations recommended for production.
- **Observability**: All HTTP requests logged with method, path, duration. Errors logged with stack trace.
- **Scaling**: The optimistic lock strategy works correctly across multiple instances as all state is in the DB.
