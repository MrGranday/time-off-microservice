import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  BadRequestException,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { SyncService } from '../sync/sync.service';
import { BalancesService } from '../balances/balances.service';
import { SyncTrigger } from '../sync/sync-log.entity';

interface HcmWebhookPayload {
  event: string;
  data: {
    employeeId: string;
    locationId: string;
    leaveType: string;
    totalDays: number;
    usedDays: number;
    effectiveDate: string;
  };
  timestamp: string;
}

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly syncService: SyncService,
    private readonly balancesService: BalancesService,
  ) {
    this.webhookSecret = this.configService.get<string>('hcm.webhookSecret')!;
  }

  /**
   * HCM pushes balance updates (e.g., anniversary bonuses, year resets).
   *
   * Security:
   * - HMAC-SHA256 signature verified before processing.
   * - Replay attack prevention: reject webhooks older than 5 minutes.
   * - We return 200 immediately; processing is inline (idempotent upsert).
   */
  @Post('hcm/balance-update')
  @HttpCode(HttpStatus.OK)
  async handleBalanceUpdate(
    @Req() req: any,
    @Headers('x-hcm-signature') signature: string,
    @Headers('x-hcm-timestamp') timestampHeader: string,
    @Body() payload: HcmWebhookPayload,
  ) {
    // ── Replay attack prevention ──────────────────────────────────────────────
    const webhookTimestamp = parseInt(timestampHeader, 10);
    const ageMs = Date.now() - webhookTimestamp;
    if (isNaN(webhookTimestamp) || ageMs > 5 * 60 * 1000) {
      throw new BadRequestException('Webhook timestamp is missing or expired');
    }

    // ── HMAC verification ─────────────────────────────────────────────────────
    const rawBody = req.rawBody?.toString('utf-8') ?? JSON.stringify(payload);
    const expectedSig = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(`${timestampHeader}.${rawBody}`)
      .digest('hex');

    const sigBuffer = Buffer.from(signature ?? '', 'hex');
    const expectedBuffer = Buffer.from(expectedSig, 'hex');

    const isValid = sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    if (!isValid) {
      this.logger.warn('Invalid HCM webhook signature rejected');
      throw new BadRequestException('Invalid webhook signature');
    }

    // ── Process event ─────────────────────────────────────────────────────────
    this.logger.log(`Processing HCM webhook event: ${payload.event}`);

    if (payload.event === 'BALANCE_UPDATED') {
      const { employeeId, locationId, leaveType, totalDays, usedDays } = payload.data;
      await this.balancesService.upsertFromHcm(
        employeeId,
        locationId,
        leaveType as any,
        totalDays,
        usedDays,
        'HCM_WEBHOOK',
      );
    }

    return { received: true, event: payload.event };
  }
}
