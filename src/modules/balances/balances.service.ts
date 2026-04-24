import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { LeaveBalance, LeaveType } from './balance.entity';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../audit/audit-log.entity';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);
  private readonly staleThresholdMs: number;

  constructor(
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.staleThresholdMs = this.configService.get<number>('sync.staleThresholdMs')!;
  }

  async findAll(employeeId: string): Promise<(LeaveBalance & { isStale: boolean })[]> {
    const balances = await this.balanceRepo.find({ where: { employeeId } });
    return balances.map((b) => Object.assign(b, { isStale: this.isStale(b) }));
  }

  async findOne(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
  ): Promise<(LeaveBalance & { isStale: boolean }) | null> {
    const bal = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });
    if (!bal) return null;
    return Object.assign(bal, { isStale: this.isStale(bal) });
  }

  async findOneOrThrow(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
  ): Promise<LeaveBalance> {
    const bal = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });
    if (!bal) {
      throw new NotFoundException(
        `No balance found for employee=${employeeId}, location=${locationId}, leaveType=${leaveType}`,
      );
    }
    return bal;
  }

  /**
   * Upserts a balance record from HCM data (batch or realtime sync).
   * Creates the record if it doesn't exist; updates totalDays/usedDays if it does.
   */
  async upsertFromHcm(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    totalDays: number,
    usedDays: number,
    actorId: string = 'SYSTEM',
  ): Promise<LeaveBalance> {
    const existing = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (!existing) {
      const newBal = this.balanceRepo.create({
        employeeId,
        locationId,
        leaveType,
        totalDays,
        usedDays,
        hcmSynced: true,
        lastSyncedAt: new Date(),
      });
      const saved = await this.balanceRepo.save(newBal);
      await this.auditService.log({
        entityType: AuditEntityType.BALANCE,
        entityId: saved.id,
        actorId,
        action: 'BALANCE_CREATED_FROM_HCM',
        newValue: saved,
      });
      return saved;
    }

    const old = { ...existing };
    existing.totalDays = totalDays;
    existing.usedDays = usedDays;
    existing.hcmSynced = true;
    existing.lastSyncedAt = new Date();
    existing.version += 1;
    const saved = await this.balanceRepo.save(existing);

    await this.auditService.log({
      entityType: AuditEntityType.BALANCE,
      entityId: saved.id,
      actorId,
      action: 'BALANCE_SYNCED_FROM_HCM',
      oldValue: old,
      newValue: saved,
    });
    return saved;
  }

  /**
   * Atomically deducts days from a balance using optimistic locking.
   *
   * Strategy:
   * 1. Load current balance and version.
   * 2. Pre-check: availableDays >= daysRequested.
   * 3. Run UPDATE ... WHERE id = ? AND version = ? (optimistic lock).
   * 4. If 0 rows updated → concurrent modification detected → retry up to 3x.
   * 5. If balance insufficient after retry → throw ConflictException.
   */
  async deductDays(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    daysRequested: number,
    requestId: string,
    actorId: string,
    maxRetries = 3,
  ): Promise<LeaveBalance> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const balance = await this.findOneOrThrow(employeeId, locationId, leaveType);

      if (balance.availableDays < daysRequested) {
        throw new ConflictException(
          `Insufficient balance. Available: ${balance.availableDays}, Requested: ${daysRequested}`,
        );
      }

      const result = await this.balanceRepo.update(
        { id: balance.id, version: balance.version },
        {
          usedDays: balance.usedDays + daysRequested,
          version: balance.version + 1,
        },
      );

      if (result.affected && result.affected > 0) {
        const updated = await this.balanceRepo.findOne({ where: { id: balance.id } });
        await this.auditService.log({
          entityType: AuditEntityType.BALANCE,
          entityId: balance.id,
          actorId,
          action: `BALANCE_DEDUCTED (requestId=${requestId})`,
          oldValue: balance,
          newValue: updated,
        });
        return updated!;
      }

      this.logger.warn(
        `Optimistic lock conflict on balance ${balance.id} (attempt ${attempt}/${maxRetries})`,
      );
      if (attempt < maxRetries) await sleep(50 * attempt);
    }

    throw new ConflictException(
      'Could not update balance after multiple attempts due to concurrent modifications',
    );
  }

  /**
   * Atomically restores days when a request is cancelled or rejected.
   */
  async restoreDays(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    days: number,
    requestId: string,
    actorId: string,
  ): Promise<void> {
    const balance = await this.findOneOrThrow(employeeId, locationId, leaveType);
    const old = { ...balance };

    const newUsedDays = Math.max(0, balance.usedDays - days);
    await this.balanceRepo.update(
      { id: balance.id },
      {
        usedDays: newUsedDays,
        version: balance.version + 1,
      },
    );

    const updated = await this.balanceRepo.findOne({ where: { id: balance.id } });
    await this.auditService.log({
      entityType: AuditEntityType.BALANCE,
      entityId: balance.id,
      actorId,
      action: `BALANCE_RESTORED (requestId=${requestId})`,
      oldValue: old,
      newValue: updated,
    });
  }

  isStale(balance: LeaveBalance): boolean {
    if (!balance.lastSyncedAt) return true;
    return Date.now() - new Date(balance.lastSyncedAt).getTime() > this.staleThresholdMs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
