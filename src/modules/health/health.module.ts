import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { HcmModule } from '../../infrastructure/hcm/hcm.module';

@Module({
  imports: [TerminusModule, HcmModule],
  controllers: [HealthController],
})
export class HealthModule {}
