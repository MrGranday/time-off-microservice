import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog, AuditEntityType } from './audit-log.entity';

export interface AuditLogInput {
  entityType: AuditEntityType;
  entityId: string;
  actorId: string;
  actorEmail?: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  /**
   * Write-only audit trail. Failures are swallowed and logged — a failing
   * audit write must never break the main business transaction.
   */
  async log(input: AuditLogInput): Promise<void> {
    try {
      const entry = this.auditRepo.create({
        entityType: input.entityType,
        entityId: input.entityId,
        actorId: input.actorId,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        oldValue: input.oldValue ? JSON.stringify(input.oldValue) : null,
        newValue: input.newValue ? JSON.stringify(input.newValue) : null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });
      await this.auditRepo.save(entry);
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  async findByEntity(entityId: string, page = 1, limit = 20): Promise<{ data: AuditLog[]; total: number }> {
    const [data, total] = await this.auditRepo.findAndCount({
      where: { entityId },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    return { data, total };
  }

  async findAll(page = 1, limit = 20): Promise<{ data: AuditLog[]; total: number }> {
    const [data, total] = await this.auditRepo.findAndCount({
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    return { data, total };
  }
}
