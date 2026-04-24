import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffRequest, RequestStatus } from './request.entity';
import { CreateRequestDto, ReviewRequestDto } from './dto/request.dto';
import { LeaveType } from '../balances/balance.entity';
import { BalancesService } from '../balances/balances.service';
import { SyncService } from '../sync/sync.service';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { AuditEntityType } from '../audit/audit-log.entity';
import { HcmAdapter, HcmApiError } from '../../infrastructure/hcm/hcm.adapter';
import { validateTransition, canEmployeeCancel } from './state-machine';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly balancesService: BalancesService,
    private readonly syncService: SyncService,
    private readonly auditService: AuditService,
    private readonly usersService: UsersService,
    private readonly hcmAdapter: HcmAdapter,
  ) {}

  /**
   * Core flow for creating a time-off request:
   * 1. Idempotency check — return existing if key matches.
   * 2. Validate date range.
   * 3. Stale balance check → refresh from HCM if needed.
   * 4. Local balance pre-check (defensive — don't trust HCM alone).
   * 5. Deduct balance optimistically.
   * 6. File with HCM.
   * 7. If HCM fails → restore balance, mark request REJECTED.
   * 8. Audit log.
   */
  async create(
    dto: CreateRequestDto,
    employeeId: string,
    idempotencyKey: string | undefined,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TimeOffRequest> {
    // ── 1. Idempotency check ─────────────────────────────────────────────────
    if (idempotencyKey) {
      const existing = await this.requestRepo.findOne({ where: { idempotencyKey } });
      if (existing) {
        this.logger.log(`Idempotency hit: returning existing request ${existing.id}`);
        return existing;
      }
    }

    // ── 2. Date validation ───────────────────────────────────────────────────
    if (dto.startDate > dto.endDate) {
      throw new BadRequestException('startDate must be on or before endDate');
    }

    // ── 3. Stale balance check ───────────────────────────────────────────────
    const balance = await this.balancesService.findOne(
      employeeId,
      dto.locationId,
      dto.leaveType,
    );

    if (!balance) {
      throw new NotFoundException(
        `No balance configured for employee=${employeeId}, location=${dto.locationId}, leaveType=${dto.leaveType}`,
      );
    }

    if (this.balancesService.isStale(balance)) {
      this.logger.log(`Balance is stale — refreshing from HCM for employee ${employeeId}`);
      await this.syncService.syncEmployeeBalance(employeeId, dto.locationId, dto.leaveType);
    }

    // ── 4. Local pre-check (defensive) ──────────────────────────────────────
    const freshBalance = await this.balancesService.findOneOrThrow(
      employeeId,
      dto.locationId,
      dto.leaveType,
    );

    if (freshBalance.availableDays < dto.daysRequested) {
      throw new ConflictException(
        `Insufficient leave balance. Available: ${freshBalance.availableDays} days, Requested: ${dto.daysRequested} days`,
      );
    }

    // ── 5. Create request record (PENDING) ───────────────────────────────────
    const request = this.requestRepo.create({
      employeeId,
      locationId: dto.locationId,
      leaveType: dto.leaveType,
      startDate: dto.startDate,
      endDate: dto.endDate,
      daysRequested: dto.daysRequested,
      reason: dto.reason ?? null,
      status: RequestStatus.PENDING,
      idempotencyKey: idempotencyKey ?? null,
    });
    const saved = await this.requestRepo.save(request);

    // ── 6. Deduct balance (optimistic lock) ──────────────────────────────────
    try {
      await this.balancesService.deductDays(
        employeeId,
        dto.locationId,
        dto.leaveType,
        dto.daysRequested,
        saved.id,
        employeeId,
      );
    } catch (err) {
      // Rollback: mark request as rejected
      saved.status = RequestStatus.REJECTED;
      saved.hcmError = `Local balance deduction failed: ${(err as Error).message}`;
      await this.requestRepo.save(saved);
      throw err;
    }

    // ── 7. File with HCM ─────────────────────────────────────────────────────
    try {
      const hcmResponse = await this.hcmAdapter.fileRequest({
        employeeId,
        locationId: dto.locationId,
        leaveType: dto.leaveType,
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysRequested: dto.daysRequested,
        reason: dto.reason,
        idempotencyKey: saved.id, // use our own ID as HCM idempotency key
      });

      saved.hcmRequestId = hcmResponse.hcmRequestId;
      saved.hcmStatus = hcmResponse.status;
    } catch (err) {
      // HCM failure: restore balance, reject request
      this.logger.error(`HCM file request failed for ${saved.id}: ${(err as Error).message}`);

      await this.balancesService.restoreDays(
        employeeId,
        dto.locationId,
        dto.leaveType,
        dto.daysRequested,
        saved.id,
        'SYSTEM',
      );

      saved.status = RequestStatus.REJECTED;
      saved.hcmError =
        err instanceof HcmApiError
          ? `HCM Error [${err.statusCode}]: ${err.message}`
          : `HCM Error: ${(err as Error).message}`;
    }

    const final = await this.requestRepo.save(saved);

    // ── 8. Audit ──────────────────────────────────────────────────────────────
    await this.auditService.log({
      entityType: AuditEntityType.REQUEST,
      entityId: final.id,
      actorId: employeeId,
      action: 'REQUEST_CREATED',
      newValue: final,
      ipAddress,
      userAgent,
    });

    return final;
  }

  async findById(id: string): Promise<TimeOffRequest> {
    const req = await this.requestRepo.findOne({ where: { id }, relations: ['employee'] });
    if (!req) throw new NotFoundException(`Request ${id} not found`);
    return req;
  }

  async findAll(
    filters: { employeeId?: string; status?: string },
    page = 1,
    limit = 20,
  ): Promise<{ data: TimeOffRequest[]; total: number; page: number; limit: number }> {
    const where: Record<string, unknown> = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.status) where.status = filters.status;

    const [data, total] = await this.requestRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 100),
      skip: (page - 1) * limit,
    });

    return { data, total, page, limit };
  }

  /**
   * Manager approves a request.
   * Authorization: the manager must be explicitly linked to the employee via manager_id.
   */
  async approve(
    requestId: string,
    managerId: string,
    dto: ReviewRequestDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TimeOffRequest> {
    const request = await this.findById(requestId);
    const old = { ...request };

    // Explicit manager link check
    const isLinked = await this.usersService.isManagerOf(managerId, request.employeeId);
    if (!isLinked) {
      throw new ForbiddenException(
        'You are not the designated manager for this employee',
      );
    }

    validateTransition(request.status, RequestStatus.APPROVED);

    request.status = RequestStatus.APPROVED;
    request.managerId = managerId;
    request.approvedBy = managerId;
    request.managerNote = dto.managerNote ?? null;
    request.reviewedAt = new Date();
    request.version += 1;

    const saved = await this.requestRepo.save(request);

    await this.auditService.log({
      entityType: AuditEntityType.REQUEST,
      entityId: saved.id,
      actorId: managerId,
      action: 'REQUEST_APPROVED',
      oldValue: old,
      newValue: saved,
      ipAddress,
      userAgent,
    });

    return saved;
  }

  /**
   * Manager rejects a request — balance is restored.
   */
  async reject(
    requestId: string,
    managerId: string,
    dto: ReviewRequestDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TimeOffRequest> {
    const request = await this.findById(requestId);
    const old = { ...request };

    const isLinked = await this.usersService.isManagerOf(managerId, request.employeeId);
    if (!isLinked) {
      throw new ForbiddenException(
        'You are not the designated manager for this employee',
      );
    }

    validateTransition(request.status, RequestStatus.REJECTED);

    // Restore balance
    await this.balancesService.restoreDays(
      request.employeeId,
      request.locationId,
      request.leaveType as LeaveType,
      request.daysRequested,
      requestId,
      managerId,
    );

    request.status = RequestStatus.REJECTED;
    request.managerId = managerId;
    request.managerNote = dto.managerNote ?? null;
    request.reviewedAt = new Date();
    request.version += 1;

    const saved = await this.requestRepo.save(request);

    await this.auditService.log({
      entityType: AuditEntityType.REQUEST,
      entityId: saved.id,
      actorId: managerId,
      action: 'REQUEST_REJECTED',
      oldValue: old,
      newValue: saved,
      ipAddress,
      userAgent,
    });

    return saved;
  }

  /**
   * Employee cancels their own PENDING or DRAFT request — balance is restored.
   */
  async cancel(
    requestId: string,
    employeeId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TimeOffRequest> {
    const request = await this.findById(requestId);

    if (request.employeeId !== employeeId) {
      throw new ForbiddenException('You can only cancel your own requests');
    }

    if (!canEmployeeCancel(request.status)) {
      throw new ForbiddenException(
        `Cannot cancel a request with status: ${request.status}`,
      );
    }

    validateTransition(request.status, RequestStatus.CANCELLED);

    const old = { ...request };

    // Restore balance only if balance was already deducted (PENDING state)
    if (request.status === RequestStatus.PENDING) {
      await this.balancesService.restoreDays(
        request.employeeId,
        request.locationId,
        request.leaveType as LeaveType,
        request.daysRequested,
        requestId,
        employeeId,
      );
    }

    request.status = RequestStatus.CANCELLED;
    request.version += 1;
    const saved = await this.requestRepo.save(request);

    await this.auditService.log({
      entityType: AuditEntityType.REQUEST,
      entityId: saved.id,
      actorId: employeeId,
      action: 'REQUEST_CANCELLED',
      oldValue: old,
      newValue: saved,
      ipAddress,
      userAgent,
    });

    return saved;
  }
}
