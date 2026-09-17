import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { PartnerApiCallKind } from '@prisma/client';
import { Observable, catchError, tap, throwError } from 'rxjs';
import {
  PARTNER_API_CALL,
  type PartnerLogRequest,
} from './partner-api-call.decorator';
import { PartnerRequestLogService } from './partner-request-log.service';

/**
 * Records each call to a handler marked `@PartnerApiCall`, whether it
 * succeeds or fails, then lets the response and the error through untouched.
 *
 * Guards run before interceptors, so a request refused by a guard never gets
 * here; `PartnerClientAuthGuard` records those itself.
 */
@Injectable()
export class PartnerRequestLogInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly log: PartnerRequestLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler();
    const kind = this.reflector.get<PartnerApiCallKind | undefined>(
      PARTNER_API_CALL,
      handler,
    );
    if (!kind || context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<PartnerLogRequest>();
    const startedAt = req.partnerCallStartedAt ?? Date.now();
    // `@HttpCode` is applied when Nest writes the response, after this runs,
    // so the status is read from the same metadata Nest will use.
    const statusCode =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, handler) ??
      (req.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);

    return next.handle().pipe(
      tap((body) =>
        this.log.record({ kind, req, startedAt, statusCode, body }),
      ),
      catchError((error: unknown) => {
        this.log.record({ kind, req, startedAt, error });
        return throwError(() => error);
      }),
    );
  }
}
