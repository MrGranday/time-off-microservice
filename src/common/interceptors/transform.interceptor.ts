import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, map } from 'rxjs/operators';
import { Request } from 'express';

export interface ApiResponse<T> {
  data: T;
  meta: {
    timestamp: string;
    path: string;
    correlationId?: string;
  };
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  private readonly logger = new Logger('HTTP');

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    const request = context.switchToHttp().getRequest<Request>();
    const start = Date.now();
    const correlationId = request.headers['x-correlation-id'] as
      | string
      | undefined;

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        this.logger.log(`[${request.method}] ${request.url} — ${duration}ms`);
      }),
      map(
        (data: T): ApiResponse<T> => ({
          data,
          meta: {
            timestamp: new Date().toISOString(),
            path: request.url,
            ...(correlationId && { correlationId }),
          },
        }),
      ),
    );
  }
}
