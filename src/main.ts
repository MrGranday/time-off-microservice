import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as helmet from 'helmet';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Expose raw body for HMAC webhook verification
    rawBody: true,
    logger: ['error', 'warn', 'log', 'debug'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port')!;
  const prefix = configService.get<string>('apiPrefix')!;

  // ── Security headers ─────────────────────────────────────────────────────────
  app.use((helmet as any).default());

  // ── Global API prefix ────────────────────────────────────────────────────────
  app.setGlobalPrefix(prefix);

  // ── Validation pipe ──────────────────────────────────────────────────────────
  // whitelist: strips unknown properties, forbidNonWhitelisted: throws on unknown
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ── CORS ─────────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: configService.get<string>('nodeEnv') === 'production'
      ? false   // configure allowed origins in prod
      : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Idempotency-Key',
      'X-Correlation-Id',
      'X-HCM-Signature',
      'X-HCM-Timestamp',
    ],
  });

  await app.listen(port);
  console.log(`🚀 Time-Off Microservice running on http://localhost:${port}/${prefix}`);
}

bootstrap();
