import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeaveBalance, LeaveType } from '../../src/modules/balances/balance.entity';
import { BalancesService } from '../../src/modules/balances/balances.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';

const mockRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
});

const mockAuditService = () => ({ log: jest.fn().mockResolvedValue(undefined) });

const mockDataSource = () => ({
  query: jest.fn(),
});

const mockConfigService = () => ({
  get: jest.fn((key: string) => {
    if (key === 'sync.staleThresholdMs') return 300000;
    return undefined;
  }),
});

describe('BalancesService', () => {
  let service: BalancesService;
  let repo: ReturnType<typeof mockRepo>;
  let dataSource: ReturnType<typeof mockDataSource>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        BalancesService,
        { provide: getRepositoryToken(LeaveBalance), useFactory: mockRepo },
        { provide: AuditService, useFactory: mockAuditService },
        { provide: ConfigService, useFactory: mockConfigService },
        { provide: DataSource, useFactory: mockDataSource },
      ],
    }).compile();

    service = module.get(BalancesService);
    repo = module.get(getRepositoryToken(LeaveBalance));
    dataSource = module.get(DataSource);
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

  describe('isStale', () => {
    it('returns true when lastSyncedAt is null', () => {
      const bal = { lastSyncedAt: null } as LeaveBalance;
      expect(service.isStale(bal)).toBe(true);
    });

    it('returns true when lastSyncedAt is older than threshold', () => {
      const bal = {
        lastSyncedAt: new Date(Date.now() - 400000),
      } as LeaveBalance;
      expect(service.isStale(bal)).toBe(true);
    });

    it('returns false when lastSyncedAt is within threshold', () => {
      const bal = {
        lastSyncedAt: new Date(Date.now() - 100000),
      } as LeaveBalance;
      expect(service.isStale(bal)).toBe(false);
    });
  });

  describe('findOneOrThrow', () => {
    it('throws NotFoundException when balance does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.findOneOrThrow('emp-1', 'loc-1', LeaveType.ANNUAL),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns balance when found', async () => {
      const balance = { id: 'bal-1', availableDays: 10 };
      repo.findOne.mockResolvedValue(balance);
      const result = await service.findOneOrThrow('emp-1', 'loc-1', LeaveType.ANNUAL);
      expect(result).toEqual(balance);
    });
  });

  describe('deductDays', () => {
    it('throws ConflictException when available days are insufficient', async () => {
      repo.findOne.mockResolvedValue({
        id: 'bal-1',
        totalDays: 5,
        usedDays: 4,
        availableDays: 1,
        version: 1,
      });
      await expect(
        service.deductDays('emp-1', 'loc-1', LeaveType.ANNUAL, 3, 'req-1', 'emp-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('succeeds on first attempt when no optimistic lock conflict', async () => {
      const balance = {
        id: 'bal-1',
        totalDays: 20,
        usedDays: 5,
        availableDays: 15,
        version: 1,
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveType: LeaveType.ANNUAL,
      };
      repo.findOne
        .mockResolvedValueOnce(balance)     // first load for deduct
        .mockResolvedValueOnce({ ...balance, usedDays: 8, version: 2 }); // after update

      repo.update.mockResolvedValue({ affected: 1 });

      const result = await service.deductDays('emp-1', 'loc-1', LeaveType.ANNUAL, 3, 'req-1', 'emp-1');
      expect(result).toBeDefined();
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('retries on optimistic lock conflict and succeeds on second attempt', async () => {
      const balance = {
        id: 'bal-1',
        totalDays: 20,
        usedDays: 5,
        availableDays: 15,
        version: 1,
      };
      repo.findOne
        .mockResolvedValueOnce(balance)
        .mockResolvedValueOnce({ ...balance, version: 2 })   // fresh load on retry
        .mockResolvedValueOnce({ ...balance, usedDays: 8, version: 3 }); // after successful update

      repo.update
        .mockResolvedValueOnce({ affected: 0 })  // first attempt: conflict (0 rows)
        .mockResolvedValueOnce({ affected: 1 }); // second attempt: success

      const result = await service.deductDays('emp-1', 'loc-1', LeaveType.ANNUAL, 3, 'req-1', 'emp-1');
      expect(result).toBeDefined();
      expect(repo.update).toHaveBeenCalledTimes(2);
    });

    it('throws ConflictException after max retries exhausted', async () => {
      const balance = {
        id: 'bal-1',
        totalDays: 20,
        usedDays: 5,
        availableDays: 15,
        version: 1,
      };
      // Always return same balance (version never changes → always conflicts)
      repo.findOne.mockResolvedValue(balance);
      // Always return 0 rows affected (lock conflict every time)
      repo.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.deductDays('emp-1', 'loc-1', LeaveType.ANNUAL, 3, 'req-1', 'emp-1', 3),
      ).rejects.toThrow(ConflictException);

      expect(repo.update).toHaveBeenCalledTimes(3);
    });
  });

  describe('upsertFromHcm', () => {
    it('creates a new balance record when none exists', async () => {
      repo.findOne.mockResolvedValue(null);
      const created = { id: 'bal-new', totalDays: 20, usedDays: 0 };
      repo.create.mockReturnValue(created);
      repo.save.mockResolvedValue(created);

      const result = await service.upsertFromHcm('emp-1', 'loc-1', LeaveType.ANNUAL, 20, 0);
      expect(repo.create).toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
      expect(result.totalDays).toBe(20);
    });

    it('updates an existing balance record', async () => {
      const existing = { id: 'bal-1', totalDays: 15, usedDays: 3, version: 1, hcmSynced: false };
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue({ ...existing, totalDays: 20, usedDays: 5, version: 2 });

      const result = await service.upsertFromHcm('emp-1', 'loc-1', LeaveType.ANNUAL, 20, 5);
      expect(result.totalDays).toBe(20);
      expect(result.version).toBe(2);
    });
  });
});
