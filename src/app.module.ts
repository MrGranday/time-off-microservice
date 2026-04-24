import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import configuration from './config/configuration';

// Entities
import { User } from './modules/users/user.entity';
import { LeaveBalance } from './modules/balances/balance.entity';
import { TimeOffRequest } from './modules/requests/request.entity';
import { SyncLog } from './modules/sync/sync-log.entity';
import { AuditLog } from './modules/audit/audit-log.entity';

// Feature Modules
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { BalancesModule } from './modules/balances/balances.module';
import { RequestsModule } from './modules/requests/requests.module';
import { SyncModule } from './modules/sync/sync.module';
import { AuditModule } from './modules/audit/audit.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { HealthModule } from './modules/health/health.module';

// Common
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { Reflector } from '@nestjs/core';

@Module({
  imports: [
    // ── Configuration ──────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env.local', '.env'],
    }),

    // ── Database ───────────────────────────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'better-sqlite3',
        database: configService.get<string>('database.path')!,
        entities: [User, LeaveBalance, TimeOffRequest, SyncLog, AuditLog],
        synchronize: configService.get<string>('nodeEnv') !== 'production',
        logging: configService.get<string>('nodeEnv') === 'development',
      }),
      inject: [ConfigService],
    }),

    // ── Rate Limiting ──────────────────────────────────────────────────────────
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: configService.get<number>('throttle.ttlMs')!,
            limit: configService.get<number>('throttle.limit')!,
          },
        ],
      }),
      inject: [ConfigService],
    }),

    // ── Feature Modules ────────────────────────────────────────────────────────
    AuthModule,
    UsersModule,
    BalancesModule,
    RequestsModule,
    SyncModule,
    AuditModule,
    WebhooksModule,
    HealthModule,
  ],

  providers: [
    // Global exception filter — catches everything
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // Global response transform
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
    Reflector,
  ],
})
export class AppModule {}
