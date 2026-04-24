import express, { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.MOCK_HCM_PORT || '4000', 10);
const FAIL_RATE = parseFloat(process.env.MOCK_HCM_FAIL_RATE || '0');
const API_KEY = process.env.HCM_API_KEY || 'mock-hcm-api-key';

// ── In-memory balance store ───────────────────────────────────────────────────
interface BalanceRecord {
  employeeId: string;
  locationId: string;
  leaveType: string;
  totalDays: number;
  usedDays: number;
  lastModifiedAt: string;
}

const balances: Map<string, BalanceRecord> = new Map();
const filedRequests: Map<string, { id: string; status: string; idempotencyKey?: string }> = new Map();

function balanceKey(employeeId: string, locationId: string, leaveType: string): string {
  return `${employeeId}::${locationId}::${leaveType}`;
}

// ── Seed data ─────────────────────────────────────────────────────────────────
function seed() {
  const now = new Date().toISOString();
  const entries: BalanceRecord[] = [
    { employeeId: 'emp-001', locationId: 'loc-NYC', leaveType: 'ANNUAL',   totalDays: 20, usedDays: 2,  lastModifiedAt: now },
    { employeeId: 'emp-001', locationId: 'loc-NYC', leaveType: 'SICK',     totalDays: 10, usedDays: 0,  lastModifiedAt: now },
    { employeeId: 'emp-002', locationId: 'loc-NYC', leaveType: 'ANNUAL',   totalDays: 15, usedDays: 3,  lastModifiedAt: now },
    { employeeId: 'emp-002', locationId: 'loc-NYC', leaveType: 'MATERNITY',totalDays: 90, usedDays: 0,  lastModifiedAt: now },
    { employeeId: 'emp-003', locationId: 'loc-LA',  leaveType: 'ANNUAL',   totalDays: 25, usedDays: 10, lastModifiedAt: now },
  ];
  entries.forEach((e) => balances.set(balanceKey(e.employeeId, e.locationId, e.leaveType), e));
  console.log(`[MockHCM] Seeded ${entries.length} balance records`);
}

// ── Middleware: API key check ─────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid API key' });
  }
  next();
});

// ── Middleware: Simulated random failures ─────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) {
    console.log(`[MockHCM] 💥 Simulated failure for ${req.method} ${req.path}`);
    return res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Simulated HCM failure' });
  }
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/hcm/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── GET /hcm/balances/:employeeId/:locationId/:leaveType ──────────────────────
app.get('/hcm/balances/:employeeId/:locationId/:leaveType', (req: Request, res: Response) => {
  const employeeId = req.params.employeeId as string;
  const locationId = req.params.locationId as string;
  const leaveType = req.params.leaveType as string;
  const key = balanceKey(employeeId, locationId, leaveType);
  const record = balances.get(key);

  if (!record) {
    return res.status(404).json({
      code: 'BALANCE_NOT_FOUND',
      message: `No balance found for employee=${employeeId}, location=${locationId}, leaveType=${leaveType}`,
    });
  }

  res.json({
    ...record,
    availableDays: record.totalDays - record.usedDays,
  });
});

// ── POST /hcm/requests — File a time-off request ──────────────────────────────
app.post('/hcm/requests', (req: Request, res: Response) => {
  const { employeeId, locationId, leaveType, daysRequested, idempotencyKey } = req.body;

  // Idempotency check
  if (idempotencyKey && filedRequests.has(idempotencyKey)) {
    const existing = filedRequests.get(idempotencyKey)!;
    return res.json({ success: true, hcmRequestId: existing.id, status: existing.status });
  }

  if (!employeeId || !locationId || !leaveType || daysRequested === undefined) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing required fields' });
  }

  const key = balanceKey(employeeId, locationId, leaveType);
  const record = balances.get(key);

  if (!record) {
    return res.status(422).json({
      code: 'INVALID_DIMENSION',
      message: `No balance exists for employee=${employeeId}, location=${locationId}, leaveType=${leaveType}`,
    });
  }

  const available = record.totalDays - record.usedDays;

  // HCM independently checks balance
  if (available < daysRequested) {
    return res.status(422).json({
      code: 'INSUFFICIENT_BALANCE',
      message: `Insufficient balance. HCM Available: ${available}, Requested: ${daysRequested}`,
    });
  }

  // Deduct in HCM
  record.usedDays += daysRequested;
  record.lastModifiedAt = new Date().toISOString();
  balances.set(key, record);

  const hcmRequestId = `HCM-${uuidv4().substring(0, 8).toUpperCase()}`;
  const entry = { id: hcmRequestId, status: 'PENDING_APPROVAL' };

  if (idempotencyKey) {
    filedRequests.set(idempotencyKey, entry);
  }

  console.log(`[MockHCM] Filed request ${hcmRequestId} for ${employeeId}: -${daysRequested} days`);

  res.json({ success: true, hcmRequestId, status: 'PENDING_APPROVAL' });
});

// ── POST /hcm/batch — Ingest full corpus ──────────────────────────────────────
app.post('/hcm/batch', (req: Request, res: Response) => {
  const { records } = req.body;

  if (!Array.isArray(records)) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'records must be an array' });
  }

  let accepted = 0;
  for (const record of records) {
    const key = balanceKey(record.employeeId, record.locationId, record.leaveType);
    balances.set(key, { ...record, lastModifiedAt: new Date().toISOString() });
    accepted++;
  }

  console.log(`[MockHCM] Batch accepted ${accepted} records`);
  res.json({ accepted });
});

// ── Admin: Simulate anniversary bonus (for testing) ───────────────────────────
app.post('/hcm/admin/anniversary-bonus', (req: Request, res: Response) => {
  const { employeeId, locationId, leaveType, bonusDays } = req.body;
  const key = balanceKey(employeeId, locationId, leaveType);
  const record = balances.get(key);

  if (!record) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Balance not found' });
  }

  record.totalDays += bonusDays;
  record.lastModifiedAt = new Date().toISOString();
  balances.set(key, record);

  console.log(`[MockHCM] 🎂 Anniversary bonus: +${bonusDays} days for ${employeeId}`);
  res.json({ success: true, newTotalDays: record.totalDays });
});

// ── Start ─────────────────────────────────────────────────────────────────────
seed();
app.listen(PORT, () => {
  console.log(`[MockHCM] 🟢 Running on http://localhost:${PORT}`);
  console.log(`[MockHCM] Fail rate: ${(FAIL_RATE * 100).toFixed(0)}%`);
});

export { app, balances };
