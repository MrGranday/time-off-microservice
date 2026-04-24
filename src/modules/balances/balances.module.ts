import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaveBalance } from './balance.entity';
import { BalancesService } from './balances.service';
import { BalancesController } from './balances.controller';
import { AuditModule } from '../audit/audit.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([LeaveBalance]),
    AuditModule,
    forwardRef(() => SyncModule),
  ],
  providers: [BalancesService],
  controllers: [BalancesController],
  exports: [BalancesService],
})
export class BalancesModule {}
