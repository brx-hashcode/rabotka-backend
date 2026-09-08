import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { SendTimingService } from './send-timing.service';

/**
 * Measures webhook handler time (entry -> response).
 *
 * Delivery latency is NOT recorded here any more. It used to be, keyed off
 * Twilio's `MessageStatus === 'delivered'` form field — a shape Cloud does not
 * post, so the metric would have gone silent at the provider flip. It now lives
 * in `InboundIngestService`, which sees a normalized status event from either
 * provider. Worth knowing when reading the dashboards: Twilio status callbacks
 * are configured in the Twilio console and nothing in this codebase sets
 * `statusCallback`, so this metric may be dark today and will come alive under
 * Cloud, which posts statuses unconditionally.
 */
@Injectable()
export class SendTimingInterceptor implements NestInterceptor {
  constructor(private readonly sendTiming: SendTimingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<{
      method: string;
      body?: Record<string, string>;
    }>();
    if (req.method !== 'POST') return next.handle();

    const body = req.body ?? {};
    const start = performance.now();
    const record = (): void =>
      this.sendTiming.observe('handler', 'inbound', performance.now() - start, {
        // Present on a Twilio form post; absent on a Cloud JSON body, where the
        // ids live nested inside `entry[]` and are not worth digging out just
        // to label a duration.
        messageSid: body.MessageSid,
        to: body.From,
      });

    return next.handle().pipe(tap({ next: record, error: record }));
  }
}
