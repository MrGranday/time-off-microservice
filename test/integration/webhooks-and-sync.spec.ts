import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import * as crypto from 'crypto';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { UserRole } from '../../src/modules/users/user.entity';
import { HcmAdapter } from '../../src/infrastructure/hcm/hcm.adapter';

async function buildApp(): Promise<INestApplication> {
  process.env.DB_PATH = ':memory:';
  process.env.JWT_SECRET = 'test-secret-minimum-32-characters-long';
  process.env.HCM_BASE_URL = 'http://localhost:4000';
  process.env.HCM_API_KEY = 'mock-hcm-api-key';
  process.env.HCM_WEBHOOK_SECRET = 'test-webhook-secret-minimum-32-chars';
  process.env.STALE_THRESHOLD_MS = '300000';

  const MockHcmAdapter = {
    getBalance: jest
      .fn()
      .mockResolvedValue({ availableDays: 30, totalDays: 30, usedDays: 0 }),
    fileRequest: jest.fn().mockResolvedValue({
      hcmRequestId: 'HCM-TEST',
      status: 'PENDING_APPROVAL',
    }),
    ingestBatch: jest.fn().mockResolvedValue({ accepted: 0 }),
    ping: jest.fn().mockResolvedValue(true),
  };

  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(HcmAdapter)
    .useValue(MockHcmAdapter)
    .compile();

  const app = module.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

const WEBHOOK_SECRET = 'test-webhook-secret-minimum-32-chars';

function makeSignature(body: string, timestamp: number | string): string {
  return crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

describe('HCM Webhook — HMAC Security', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  beforeAll(async () => {
    // Suppress GlobalExceptionFilter noise from expected 4xx paths
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    app = await buildApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'admin@test.com',
        name: 'Admin',
        password: 'password123',
      });
    const adminId = res.body.data.user.id;
    await dataSource.query(`UPDATE users SET role = 'ADMIN' WHERE id = ?`, [
      adminId,
    ]);

    await dataSource.query(
      `INSERT INTO users (id, email, name, password, role, is_active, created_at, updated_at)
       VALUES ('emp-wh-1', 'wh@test.com', 'WH', 'pass', 'EMPLOYEE', 1, datetime('now'), datetime('now'))`,
    );

    await dataSource.query(
      `INSERT INTO leave_balances (id, employee_id, location_id, leave_type, total_days, used_days, version, hcm_synced, last_synced_at, created_at, updated_at)
       VALUES ('wh-bal-1', 'emp-wh-1', 'loc-NYC', 'ANNUAL', 15, 0, 1, 1, datetime('now'), datetime('now'), datetime('now'))`,
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('returns 400 when X-HCM-Signature header is missing', async () => {
    const payload = {
      event: 'BALANCE_UPDATED',
      timestamp: new Date().toISOString(),
      data: {
        employeeId: 'emp-wh-1',
        locationId: 'loc-NYC',
        leaveType: 'ANNUAL',
        totalDays: 20,
        usedDays: 0,
        effectiveDate: '2025-01-01',
      },
    };
    const timestamp = Date.now();

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/hcm/balance-update')
      .set('Content-Type', 'application/json')
      .set('X-HCM-Timestamp', String(timestamp))
      .send(JSON.stringify(payload));

    expect(res.status).toBe(400);
  });

  it('returns 400 when signature is invalid (tampering)', async () => {
    const payload = {
      event: 'BALANCE_UPDATED',
      timestamp: new Date().toISOString(),
      data: {
        employeeId: 'emp-wh-1',
        locationId: 'loc-NYC',
        leaveType: 'ANNUAL',
        totalDays: 20,
        usedDays: 0,
        effectiveDate: '2025-01-01',
      },
    };
    const timestamp = Date.now();
    const body = JSON.stringify(payload);
    const badSig =
      'aabbcc0000000000000000000000000000000000000000000000000000000000';

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/hcm/balance-update')
      .set('Content-Type', 'application/json')
      .set('X-HCM-Signature', badSig)
      .set('X-HCM-Timestamp', String(timestamp))
      .send(body);

    expect(res.status).toBe(400);
  });

  it('returns 400 for replay attack (timestamp older than 5 minutes)', async () => {
    const payload = {
      event: 'BALANCE_UPDATED',
      timestamp: new Date().toISOString(),
      data: {
        employeeId: 'emp-wh-1',
        locationId: 'loc-NYC',
        leaveType: 'ANNUAL',
        totalDays: 20,
        usedDays: 0,
        effectiveDate: '2025-01-01',
      },
    };
    const staleTimestamp = Date.now() - 6 * 60 * 1000;
    const body = JSON.stringify(payload);
    const sig = makeSignature(body, staleTimestamp);

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/hcm/balance-update')
      .set('Content-Type', 'application/json')
      .set('X-HCM-Signature', sig)
      .set('X-HCM-Timestamp', String(staleTimestamp))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('processes valid webhook and updates balance', async () => {
    const payload = {
      event: 'BALANCE_UPDATED',
      timestamp: new Date().toISOString(),
      data: {
        employeeId: 'emp-wh-1',
        locationId: 'loc-NYC',
        leaveType: 'ANNUAL',
        totalDays: 25,
        usedDays: 0,
        effectiveDate: '2025-01-01',
      },
    };
    const timestamp = Date.now();
    const body = JSON.stringify(payload);
    const sig = makeSignature(body, timestamp);

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/hcm/balance-update')
      .set('Content-Type', 'application/json')
      .set('X-HCM-Signature', sig)
      .set('X-HCM-Timestamp', String(timestamp))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);

    const [updated] = await dataSource.query(
      `SELECT total_days FROM leave_balances WHERE employee_id = 'emp-wh-1' AND location_id = 'loc-NYC' AND leave_type = 'ANNUAL'`,
    );
    expect(updated?.total_days).toBe(25);
  });
});

describe('Batch Sync (Integration)', () => {
  let app: INestApplication;
  let adminToken: string;
  let dataSource: DataSource;
  let employeeToken: string;
  let jwtService: JwtService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    app = await buildApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'sync-admin@test.com',
        name: 'SyncAdmin',
        password: 'password123',
      });
    const adminId = res.body.data.user.id;
    await dataSource.query(`UPDATE users SET role = 'ADMIN' WHERE id = ?`, [
      adminId,
    ]);
    adminToken = jwtService.sign({
      sub: adminId,
      email: 'sync-admin@test.com',
      role: UserRole.ADMIN,
    });

    await dataSource.query(
      `INSERT INTO users (id, email, name, password, role, is_active, created_at, updated_at)
       VALUES ('batch-emp-1', 'b1@test.com', 'B1', 'pass', 'EMPLOYEE', 1, datetime('now'), datetime('now'))`,
    );
    await dataSource.query(
      `INSERT INTO users (id, email, name, password, role, is_active, created_at, updated_at)
       VALUES ('batch-emp-2', 'b2@test.com', 'B2', 'pass', 'EMPLOYEE', 1, datetime('now'), datetime('now'))`,
    );

    employeeToken = jwtService.sign({
      sub: 'batch-emp-1',
      email: 'b1@test.com',
      role: UserRole.EMPLOYEE,
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('returns 403 for non-admin users', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sync/batch')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ records: [] });
    expect(res.status).toBe(403);
  });

  it('ingests batch records and creates balances', async () => {
    const records = [
      {
        employeeId: 'batch-emp-1',
        locationId: 'loc-BATCH',
        leaveType: 'ANNUAL',
        totalDays: 22,
        usedDays: 4,
        lastModifiedAt: new Date().toISOString(),
      },
      {
        employeeId: 'batch-emp-2',
        locationId: 'loc-BATCH',
        leaveType: 'SICK',
        totalDays: 10,
        usedDays: 1,
        lastModifiedAt: new Date().toISOString(),
      },
    ];

    const res = await request(app.getHttpServer())
      .post('/api/v1/sync/batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ records });

    expect(res.status).toBe(200);
    expect(res.body.data.synced).toBe(2);
    expect(res.body.data.failed).toBe(0);

    const [bal] = await dataSource.query(
      `SELECT total_days, used_days FROM leave_balances WHERE employee_id = 'batch-emp-1' AND leave_type = 'ANNUAL'`,
    );
    expect(bal?.total_days).toBe(22);
  });
});
