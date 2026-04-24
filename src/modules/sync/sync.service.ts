import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncLog, SyncStatus, SyncTrigger, SyncType } from './sync-log.entity';
import { BalancesService } from '../balances/balances.service';
import { HcmAdapter } from '../../infrastructure/hcm/hcm.adapter';
import { HcmBatchRecord } from '../../infrastructure/hcm/hcm.types';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @Inject(forwardRef(() => BalancesService))
    private readonly balancesService: BalancesService,
    private readonly hcmAdapter: HcmAdapter,
  ) {}

  /**
   * Real-time sync for a single balance dimension.
   * Called when a balance is found to be stale before a request is created.
   */
  async syncEmployeeBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
    trigger: SyncTrigger = SyncTrigger.REQUEST,
  ): Promise<void> {
    const start = Date.now();
    const log = this.syncLogRepo.create({
      syncType: SyncType.REALTIME,
      employeeId,
      locationId,
      leaveType,
      status: SyncStatus.SUCCESS,
      recordsSynced: 0,
      triggeredBy: trigger,
    });

    try {
      const hcmBalance = await this.hcmAdapter.getBalance(employeeId, locationId, leaveType);

      await this.balancesService.upsertFromHcm(
        employeeId,
        locationId,
        leaveType as any,
        hcmBalance.totalDays,
        hcmBalance.usedDays,
        'SYSTEM_SYNC',
      );

      log.recordsSynced = 1;
      log.status = SyncStatus.SUCCESS;
      this.logger.log(`Real-time sync complete for employee=${employeeId}`);
    } catch (err) {
      log.status = SyncStatus.FAILED;
      log.errorDetail = (err as Error).message;
      this.logger.error(`Real-time sync failed for employee=${employeeId}: ${(err as Error).message}`);
    } finally {
      log.durationMs = Date.now() - start;
      await this.syncLogRepo.save(log);
    }
  }

  /**
   * Batch sync — ingests the full corpus of balance records from HCM.
   * This is additive: update-or-insert, never delete local records.
   * Called by nightly cron or manual admin trigger.
   */
  async runBatchSync(
    records: HcmBatchRecord[],
    trigger: SyncTrigger = SyncTrigger.CRON,
    actorId = 'SYSTEM',
  ): Promise<{ synced: number; failed: number }> {
    const start = Date.now();
    const log = this.syncLogRepo.create({
      syncType: SyncType.BATCH,
      status: SyncStatus.SUCCESS,
      recordsSynced: 0,
      triggeredBy: trigger,
    });

    let synced = 0;
    let failed = 0;

    for (const record of records) {
      try {
        await this.balancesService.upsertFromHcm(
          record.employeeId,
          record.locationId,
          record.leaveType as any,
          record.totalDays,
          record.usedDays,
          actorId,
        );
        synced++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Batch sync failed for employee=${record.employeeId}: ${(err as Error).message}`,
        );
      }
    }

    log.recordsSynced = synced;
    log.status = failed > 0 && synced === 0 ? SyncStatus.FAILED : failed > 0 ? SyncStatus.PARTIAL : SyncStatus.SUCCESS;
    log.errorDetail = failed > 0 ? `${failed} records failed to sync` : null;
    log.durationMs = Date.now() - start;
    await this.syncLogRepo.save(log);

    this.logger.log(`Batch sync complete: ${synced} synced, ${failed} failed in ${log.durationMs}ms`);
    return { synced, failed };
  }

  async getLogs(page = 1, limit = 20): Promise<{ data: SyncLog[]; total: number }> {
    const [data, total] = await this.syncLogRepo.findAndCount({
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    return { data, total };
  }
}
