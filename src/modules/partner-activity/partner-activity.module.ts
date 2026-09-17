import { Module } from '@nestjs/common';
import { PartnerRequestLogInterceptor } from './partner-request-log.interceptor';
import { PartnerRequestLogService } from './partner-request-log.service';

/**
 * The partner activity log. A leaf module — Prisma and the queue are global —
 * so both `OAuthModule` and `IdentityCheckModule` can import it without a
 * cycle. It finds apps by `client_id` itself rather than through OAuthModule.
 */
@Module({
  providers: [PartnerRequestLogService, PartnerRequestLogInterceptor],
  exports: [PartnerRequestLogService, PartnerRequestLogInterceptor],
})
export class PartnerActivityModule {}
