import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  SyncLog,
  SyncStatus,
  SyncTrigger,
} from '../../src/modules/sync/sync-log.entity';
import { SyncService } from '../../src/modules/sync/sync.service';
import { BalancesService } from '../../src/modules/balances/balances.service';
import { HcmAdapter } from '../../src/infrastructure/hcm/hcm.adapter';

const mockSyncLogRepo = () => ({
  create: jest.fn((data) => data),
  save: jest.fn().mockResolvedValue({}),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
});

const mockBalancesService = () => ({
  upsertFromHcm: jest.fn().mockResolvedValue({}),
});

const mockHcmAdapter = () => ({
  getBalance: jest.fn(),
});

describe('SyncService', () => {
  let service: SyncService;
  let syncLogRepo: ReturnType<typeof mockSyncLogRepo>;
  let balancesService: ReturnType<typeof mockBalancesService>;
  let hcmAdapter: ReturnType<typeof mockHcmAdapter>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(SyncLog), useFactory: mockSyncLogRepo },
        { provide: BalancesService, useFactory: mockBalancesService },
        { provide: HcmAdapter, useFactory: mockHcmAdapter },
      ],
    }).compile();

    service = module.get(SyncService);
    syncLogRepo = module.get(getRepositoryToken(SyncLog));
    balancesService = module.get(BalancesService);
    hcmAdapter = module.get(HcmAdapter);
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('syncEmployeeBalance', () => {
    it('fetches from HCM and upserts balance on success', async () => {
      hcmAdapter.getBalance.mockResolvedValue({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveType: 'ANNUAL',
        totalDays: 20,
        usedDays: 5,
        availableDays: 15,
        lastModifiedAt: new Date().toISOString(),
      });

      await service.syncEmployeeBalance('emp-1', 'loc-1', 'ANNUAL');

      expect(hcmAdapter.getBalance).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'ANNUAL',
      );
      expect(balancesService.upsertFromHcm).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        'ANNUAL',
        20,
        5,
        'SYSTEM_SYNC',
      );
      expect(syncLogRepo.save).toHaveBeenCalled();
    });

    it('writes FAILED sync log when HCM call fails', async () => {
      hcmAdapter.getBalance.mockRejectedValue(new Error('HCM timeout'));

      await service.syncEmployeeBalance('emp-1', 'loc-1', 'ANNUAL');

      expect(balancesService.upsertFromHcm).not.toHaveBeenCalled();
      const savedLog = syncLogRepo.save.mock.calls[0][0];
      expect(savedLog.status).toBe(SyncStatus.FAILED);
      expect(savedLog.errorDetail).toContain('HCM timeout');
    });

    it('uses REQUEST trigger by default', async () => {
      hcmAdapter.getBalance.mockResolvedValue({ totalDays: 10, usedDays: 2 });
      await service.syncEmployeeBalance('emp-1', 'loc-1', 'ANNUAL');
      const savedLog = syncLogRepo.save.mock.calls[0][0];
      expect(savedLog.triggeredBy).toBe(SyncTrigger.REQUEST);
    });
  });

  describe('runBatchSync', () => {
    it('syncs all records and returns counts', async () => {
      const records = [
        {
          employeeId: 'e1',
          locationId: 'l1',
          leaveType: 'ANNUAL',
          totalDays: 20,
          usedDays: 5,
          lastModifiedAt: '',
        },
        {
          employeeId: 'e2',
          locationId: 'l1',
          leaveType: 'SICK',
          totalDays: 10,
          usedDays: 0,
          lastModifiedAt: '',
        },
      ];

      const result = await service.runBatchSync(records, SyncTrigger.MANUAL);

      expect(result.synced).toBe(2);
      expect(result.failed).toBe(0);
      expect(balancesService.upsertFromHcm).toHaveBeenCalledTimes(2);
    });

    it('counts partial failures correctly', async () => {
      const records = [
        {
          employeeId: 'e1',
          locationId: 'l1',
          leaveType: 'ANNUAL',
          totalDays: 20,
          usedDays: 5,
          lastModifiedAt: '',
        },
        {
          employeeId: 'e2',
          locationId: 'l1',
          leaveType: 'SICK',
          totalDays: 10,
          usedDays: 0,
          lastModifiedAt: '',
        },
      ];

      balancesService.upsertFromHcm
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('DB error'));

      const result = await service.runBatchSync(records, SyncTrigger.MANUAL);

      expect(result.synced).toBe(1);
      expect(result.failed).toBe(1);
      const savedLog = syncLogRepo.save.mock.calls[0][0];
      expect(savedLog.status).toBe(SyncStatus.PARTIAL);
    });

    it('marks log as FAILED when all records fail', async () => {
      const records = [
        {
          employeeId: 'e1',
          locationId: 'l1',
          leaveType: 'ANNUAL',
          totalDays: 20,
          usedDays: 5,
          lastModifiedAt: '',
        },
      ];
      balancesService.upsertFromHcm.mockRejectedValue(new Error('Fatal'));

      const result = await service.runBatchSync(records);
      expect(result.synced).toBe(0);
      expect(result.failed).toBe(1);
      const savedLog = syncLogRepo.save.mock.calls[0][0];
      expect(savedLog.status).toBe(SyncStatus.FAILED);
    });
  });
});
