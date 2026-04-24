import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HcmBalance,
  HcmBatchPayload,
  HcmFileRequestPayload,
  HcmFileRequestResponse,
} from './hcm.types';

/**
 * HcmAdapter — thin anti-corruption layer over the external HCM API.
 *
 * Design principles:
 * 1. All network calls go through this class. Nothing else imports fetch/axios for HCM.
 * 2. Retries with exponential backoff — HCM is unreliable.
 * 3. Timeout on every call — never block forever.
 * 4. Never throw raw fetch errors — translate them to domain exceptions.
 */
@Injectable()
export class HcmAdapter {
  private readonly logger = new Logger(HcmAdapter.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('hcm.baseUrl')!;
    this.apiKey = this.configService.get<string>('hcm.apiKey')!;
    this.timeoutMs = this.configService.get<number>('hcm.timeoutMs')!;
    this.retryAttempts = this.configService.get<number>('hcm.retryAttempts')!;
    this.retryDelayMs = this.configService.get<number>('hcm.retryDelayMs')!;
  }

  /**
   * Fetches real-time balance for a specific (employee, location, leaveType) tuple.
   */
  async getBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
  ): Promise<HcmBalance> {
    const url = `${this.baseUrl}/hcm/balances/${employeeId}/${locationId}/${leaveType}`;
    const data = await this.request<HcmBalance>('GET', url);
    return data;
  }

  /**
   * Files a time-off request against HCM.
   * HCM may return an error for insufficient balance or invalid dimensions.
   * Even if HCM returns success, callers must still verify locally (defensive posture).
   */
  async fileRequest(payload: HcmFileRequestPayload): Promise<HcmFileRequestResponse> {
    const url = `${this.baseUrl}/hcm/requests`;
    return this.request<HcmFileRequestResponse>('POST', url, payload);
  }

  /**
   * Accepts the full batch corpus from HCM.
   * Used for nightly sync and manual admin-triggered syncs.
   */
  async ingestBatch(payload: HcmBatchPayload): Promise<{ accepted: number }> {
    const url = `${this.baseUrl}/hcm/batch`;
    return this.request<{ accepted: number }>('POST', url, payload);
  }

  /**
   * Checks HCM health — used by the /health/ready endpoint.
   */
  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>('GET', `${this.baseUrl}/hcm/health`);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            'X-Request-Attempt': String(attempt),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message =
            (errorBody as any)?.message || `HCM returned ${response.status}`;
          throw new HcmApiError(message, response.status, errorBody);
        }

        return response.json() as Promise<T>;
      } catch (err) {
        lastError = err as Error;

        // Re-throw domain errors immediately — don't retry bad requests
        if (err instanceof HcmApiError && err.statusCode < 500) {
          throw err;
        }

        if (attempt < this.retryAttempts) {
          const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
          this.logger.warn(
            `HCM call failed (attempt ${attempt}/${this.retryAttempts}). Retrying in ${delay}ms. Error: ${lastError.message}`,
          );
          await sleep(delay);
        }
      }
    }

    this.logger.error(`HCM call failed after ${this.retryAttempts} attempts: ${lastError?.message}`);
    throw new ServiceUnavailableException(
      `HCM service is unavailable after ${this.retryAttempts} retries`,
    );
  }
}

export class HcmApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'HcmApiError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
