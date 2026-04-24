import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { SyncModule } from '../sync/sync.module';
import { BalancesModule } from '../balances/balances.module';

@Module({
  imports: [SyncModule, BalancesModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
