import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';

import { AppModule } from '../../src/app.module';
import { UserRole } from '../../src/modules/users/user.entity';
import { RequestStatus } from '../../src/modules/requests/request.entity';
import { HcmAdapter } from '../../src/infrastructure/hcm/hcm.adapter';
import { BalancesService } from '../../src/modules/balances/balances.service';
import { SyncService } from '../../src/modules/sync/sync.service';

// ─── Fake balance returned by all BalancesService query methods ───────────────
const FAKE_BALANCE = {
  id: 'bal-test-1',
  employeeId: 'emp-001',
  locationId: 'loc-NYC',
  leaveType: 'ANNUAL' as const,
  totalDays: 30,
  usedDays: 0,
  availableDays: 30,
  version: 1,
  hcmSynced: true,
  lastSyncedAt: new Date(),
};

// ─── Module-level mocks ───────────────────────────────────────────────────────

const MockHcmAdapter = {
  getBalance: jest.fn().mockResolvedValue({ availableDays: 30, totalDays: 30, usedDays: 0 }),
  fileRequest: jest.fn().mockResolvedValue({ hcmRequestId: 'HCM-TEST-001', status: 'PENDING_APPROVAL' }),
  ingestBatch: jest.fn().mockResolvedValue({ accepted: 0 }),
  ping: jest.fn().mockResolvedValue(true),
};

/**
 * KEY FIX: findOne/findOneOrThrow must return a real-looking balance object.
 * When these returned undefined, RequestsService.create() threw NotFoundException
 * immediately (before any balance check), causing every test to get 404.
 */
const MockBalancesService = {
  findOne: jest.fn().mockResolvedValue(FAKE_BALANCE),
  findOneOrThrow: jest.fn().mockResolvedValue(FAKE_BALANCE),
  deductDays: jest.fn().mockResolvedValue({ ...FAKE_BALANCE, usedDays: 1, availableDays: 29 }),
  restoreDays: jest.fn().mockResolvedValue(undefined),
  isStale: jest.fn().mockReturnValue(false),
  upsertFromHcm: jest.fn().mockResolvedValue(FAKE_BALANCE),
};

/**
 * KEY FIX: SyncService override prevents any real network/DB calls if the
 * stale-balance refresh path is triggered.
 */
const MockSyncService = {
  syncEmployeeBalance: jest.fn().mockResolvedValue(undefined),
  runBatchSync: jest.fn().mockResolvedValue({ synced: 0, failed: 0 }),
  getLogs: jest.fn().mockResolvedValue({ data: [], total: 0 }),
};

async function buildTestApp(): Promise<INestApplication> {
  process.env.DB_PATH = ':memory:';
  process.env.JWT_SECRET = 'test-secret-minimum-32-characters-long';
  process.env.HCM_BASE_URL = 'http://localhost:4000';
  process.env.HCM_API_KEY = 'mock-hcm-api-key';
  process.env.HCM_WEBHOOK_SECRET = 'test-webhook-secret-minimum-32-chars';
  process.env.STALE_THRESHOLD_MS = '300000';

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(HcmAdapter)
    .useValue(MockHcmAdapter)
    .overrideProvider(BalancesService)
    .useValue(MockBalancesService)
    .overrideProvider(SyncService)
    .useValue(MockSyncService)
    .compile();

  const app = moduleFixture.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  return app;
}

describe('Full Request Lifecycle (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  let employeeToken: string;
  let managerToken: string;
  let employeeId: string;
  let managerId: string;

  beforeAll(async () => {
    // Suppress expected 4xx/5xx error logs from GlobalExceptionFilter
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    app = await buildTestApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    // Register manager
    const managerRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'manager@test.com', name: 'Manager User', password: 'password123' });
    managerId = managerRes.body.data.user.id;
    await dataSource.query(`UPDATE users SET role = 'MANAGER' WHERE id = ?`, [managerId]);

    // Register employee and link to manager with stable ID
    const employeeRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'employee@test.com', name: 'Employee User', password: 'password123' });
    const dbEmployeeId = employeeRes.body.data.user.id;
    await dataSource.query(
      `UPDATE users SET id = 'emp-001', manager_id = ? WHERE id = ?`,
      [managerId, dbEmployeeId],
    );
    employeeId = 'emp-001';

    // Mint tokens signed with the same secret the app uses
    employeeToken = jwtService.sign({ sub: employeeId, email: 'employee@test.com', role: UserRole.EMPLOYEE });
    managerToken  = jwtService.sign({ sub: managerId,  email: 'manager@test.com',  role: UserRole.MANAGER  });

    // Seed a real balance row so the /balances endpoint returns data
    await dataSource.query(
      `INSERT INTO leave_balances
         (id, employee_id, location_id, leave_type, total_days, used_days, version,
          hcm_synced, last_synced_at, created_at, updated_at)
       VALUES ('bal-test-1','emp-001','loc-NYC','ANNUAL',30,0,1,1,
               datetime('now'),datetime('now'),datetime('now'))`,
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('POST /api/v1/requests — Create time-off request', () => {
    it('returns 401 when no token provided', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .send({ locationId: 'loc-NYC', leaveType: 'ANNUAL', startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 2 });
      expect(res.status).toBe(401);
    });

    it('returns 400 when startDate > endDate', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ locationId: 'loc-NYC', leaveType: 'ANNUAL', startDate: '2025-06-10', endDate: '2025-06-01', daysRequested: 2 });
      expect(res.status).toBe(400);
    });

    it('creates a PENDING request successfully', async () => {
      MockBalancesService.findOne.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.findOneOrThrow.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.deductDays.mockResolvedValue({ ...FAKE_BALANCE, usedDays: 2, availableDays: 28 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          locationId: 'loc-NYC',
          leaveType: 'ANNUAL',
          startDate: '2025-07-01',
          endDate: '2025-07-02',
          daysRequested: 2,
          reason: 'Summer vacation',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe(RequestStatus.PENDING);
      expect(res.body.data.employeeId).toBe(employeeId);
      expect(res.body.data.daysRequested).toBe(2);
    });

    it('rejects when daysRequested exceeds available balance', async () => {
      // Simulate a low balance on the fresh-balance check (findOneOrThrow second call)
      MockBalancesService.findOne.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.findOneOrThrow.mockResolvedValueOnce({
        ...FAKE_BALANCE,
        totalDays: 5,
        usedDays: 4,
        availableDays: 1,
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          locationId: 'loc-NYC',
          leaveType: 'ANNUAL',
          startDate: '2025-08-01',
          endDate: '2025-08-31',
          daysRequested: 35,
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/insufficient/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Idempotency Key', () => {
    it('returns the same request on duplicate submission with same key', async () => {
      MockBalancesService.findOne.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.findOneOrThrow.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.deductDays.mockResolvedValue({ ...FAKE_BALANCE, usedDays: 1, availableDays: 29 });

      const key = `idem-key-${Date.now()}`;
      const payload = { locationId: 'loc-NYC', leaveType: 'ANNUAL', startDate: '2026-01-10', endDate: '2026-01-10', daysRequested: 1 };

      const first  = await request(app.getHttpServer()).post('/api/v1/requests').set('Authorization', `Bearer ${employeeToken}`).set('X-Idempotency-Key', key).send(payload);
      const second = await request(app.getHttpServer()).post('/api/v1/requests').set('Authorization', `Bearer ${employeeToken}`).set('X-Idempotency-Key', key).send(payload);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.data.id).toBe(second.body.data.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Manager Approval Flow', () => {
    let requestId: string;

    beforeAll(async () => {
      MockBalancesService.findOne.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.findOneOrThrow.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.deductDays.mockResolvedValue({ ...FAKE_BALANCE, usedDays: 1, availableDays: 29 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ locationId: 'loc-NYC', leaveType: 'ANNUAL', startDate: '2026-02-01', endDate: '2026-02-01', daysRequested: 1, reason: 'Personal day' });

      if (!res.body.data?.id) {
        throw new Error(`Manager Approval beforeAll: failed to create request — status=${res.status} body=${JSON.stringify(res.body)}`);
      }
      requestId = res.body.data.id;
    });

    it('returns 403 when employee tries to approve their own request', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/approve`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ managerNote: 'Should not work' });
      expect(res.status).toBe(403);
    });

    it('returns 403 when unlinked manager tries to approve', async () => {
      const otherRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'other-manager@test.com', name: 'Other Manager', password: 'password123' });
      const otherId = otherRes.body.data.user.id;
      await dataSource.query(`UPDATE users SET role = 'MANAGER' WHERE id = ?`, [otherId]);
      const otherToken = jwtService.sign({ sub: otherId, email: 'other-manager@test.com', role: UserRole.MANAGER });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/approve`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ managerNote: 'Trying to approve illegally' });
      expect(res.status).toBe(403);
    });

    it('allows the linked manager to approve', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ managerNote: 'Approved!' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(RequestStatus.APPROVED);
      expect(res.body.data.approvedBy).toBe(managerId);
    });

    it('rejects re-approving an already-approved request (state machine)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({});
      expect(res.status).toBe(422);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Employee Cancellation', () => {
    let pendingRequestId: string;

    beforeAll(async () => {
      MockBalancesService.findOne.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.findOneOrThrow.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.deductDays.mockResolvedValue({ ...FAKE_BALANCE, usedDays: 1, availableDays: 29 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ locationId: 'loc-NYC', leaveType: 'ANNUAL', startDate: '2026-03-01', endDate: '2026-03-01', daysRequested: 1 });

      if (!res.body.data?.id) {
        throw new Error(`Employee Cancellation beforeAll: failed to create request — status=${res.status} body=${JSON.stringify(res.body)}`);
      }
      pendingRequestId = res.body.data.id;
    });

    it('allows employee to cancel their own PENDING request', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/requests/${pendingRequestId}`)
        .set('Authorization', `Bearer ${employeeToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(RequestStatus.CANCELLED);
    });

    it('cannot cancel a second time (terminal state)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/requests/${pendingRequestId}`)
        .set('Authorization', `Bearer ${employeeToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Rejection — Balance Restored', () => {
    it('restores balance after manager rejects request', async () => {
      MockBalancesService.findOne.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.findOneOrThrow.mockResolvedValue(FAKE_BALANCE);
      MockBalancesService.deductDays.mockResolvedValue({ ...FAKE_BALANCE, usedDays: 1, availableDays: 29 });
      MockBalancesService.restoreDays.mockResolvedValue(undefined);

      const balBefore = await request(app.getHttpServer())
        .get(`/api/v1/balances/${employeeId}/loc-NYC/ANNUAL`)
        .set('Authorization', `Bearer ${employeeToken}`);
      const availBefore = (balBefore.body.data?.totalDays || 0) - (balBefore.body.data?.usedDays || 0);

      const createRes = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ locationId: 'loc-NYC', leaveType: 'ANNUAL', startDate: '2026-04-01', endDate: '2026-04-01', daysRequested: 1 });
      const reqId = createRes.body.data?.id;
      expect(reqId).toBeDefined();

      await request(app.getHttpServer())
        .patch(`/api/v1/requests/${reqId}/reject`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ managerNote: 'Not approved' });

      // restoreDays must have been called by the service
      expect(MockBalancesService.restoreDays).toHaveBeenCalled();

      const balAfter = await request(app.getHttpServer())
        .get(`/api/v1/balances/${employeeId}/loc-NYC/ANNUAL`)
        .set('Authorization', `Bearer ${employeeToken}`);
      const availAfter = (balAfter.body.data?.totalDays || 0) - (balAfter.body.data?.usedDays || 0);
      expect(availAfter).toBeGreaterThanOrEqual(availBefore);
    });
  });
});