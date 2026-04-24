import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncLog } from './sync-log.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { HcmModule } from '../../infrastructure/hcm/hcm.module';
import { AuditModule } from '../audit/audit.module';
import { BalancesModule } from '../balances/balances.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncLog]),
    HcmModule,
    AuditModule,
    forwardRef(() => BalancesModule),
  ],
  providers: [SyncService],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
