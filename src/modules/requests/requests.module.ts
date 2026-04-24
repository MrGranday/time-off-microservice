import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './request.entity';
import { RequestsService } from './requests.service';
import { RequestsController } from './requests.controller';
import { BalancesModule } from '../balances/balances.module';
import { SyncModule } from '../sync/sync.module';
import { AuditModule } from '../audit/audit.module';
import { UsersModule } from '../users/users.module';
import { HcmModule } from '../../infrastructure/hcm/hcm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest]),
    BalancesModule,
    SyncModule,
    AuditModule,
    UsersModule,
    HcmModule,
  ],
  providers: [RequestsService],
  controllers: [RequestsController],
  exports: [RequestsService],
})
export class RequestsModule {}
