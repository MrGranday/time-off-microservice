import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { HcmAdapter } from '../../infrastructure/hcm/hcm.adapter';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    private hcmAdapter: HcmAdapter,
  ) {}

  @Get()
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @HealthCheck()
  async readiness() {
    const hcmReachable = await this.hcmAdapter.ping();
    return this.health.check([
      () => this.db.pingCheck('database'),
      () =>
        Promise.resolve({
          hcm: {
            status: hcmReachable ? 'up' : 'down',
          },
        }),
    ]);
  }
}
