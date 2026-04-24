import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HcmAdapter, HcmApiError } from '../../src/infrastructure/hcm/hcm.adapter';
import { ServiceUnavailableException, Logger } from '@nestjs/common';

describe('HcmAdapter', () => {
  let adapter: HcmAdapter;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'hcm.baseUrl':
          return 'http://hcm.test';
        case 'hcm.apiKey':
          return 'test-api-key';
        case 'hcm.timeoutMs':
          return 100;
        case 'hcm.retryAttempts':
          return 3;
        case 'hcm.retryDelayMs':
          return 10;
        default:
          return null;
      }
    }),
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmAdapter,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    adapter = module.get<HcmAdapter>(HcmAdapter);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully get balance', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ employeeId: '1', totalDays: 10 }),
    });

    const res = await adapter.getBalance('1', 'LOC1', 'ANNUAL');
    expect(res).toEqual({ employeeId: '1', totalDays: 10 });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://hcm.test/hcm/balances/1/LOC1/ANNUAL',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should successfully file request', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hcmRequestId: 'HCM-1', status: 'PENDING' }),
    });

    const payload = { employeeId: '1', locationId: 'L', leaveType: 'A', daysRequested: 2, idempotencyKey: 'x', startDate: '2025-01-01', endDate: '2025-01-02' };
    const res = await adapter.fileRequest(payload);
    expect(res.hcmRequestId).toBe('HCM-1');
  });

  it('should successfully ingest batch', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ accepted: 5 }),
    });

    const res = await adapter.ingestBatch({ records: [], generatedAt: new Date().toISOString() });
    expect(res.accepted).toBe(5);
  });

  it('should return true for ping on success', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });
    const res = await adapter.ping();
    expect(res).toBe(true);
  });

  it('should return false for ping on failure', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
    const res = await adapter.ping();
    expect(res).toBe(false);
  });

  it('should throw HcmApiError immediately on 400 error (no retry)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Bad Request' }),
    });

    await expect(adapter.getBalance('1', 'L', 'A')).rejects.toThrow(HcmApiError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on 500 error and throw ServiceUnavailableException if all retries fail', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(adapter.getBalance('1', 'L', 'A')).rejects.toThrow(ServiceUnavailableException);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('should retry on network error and eventually succeed', async () => {
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('Network fail'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

    const res = await adapter.getBalance('1', 'L', 'A');
    expect(res).toEqual({ success: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should handle timeout/abort error gracefully via retry', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(() => {
      throw new Error('AbortError');
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const res = await adapter.getBalance('1', 'L', 'A');
    expect(res).toEqual({ success: true });
  });
});
