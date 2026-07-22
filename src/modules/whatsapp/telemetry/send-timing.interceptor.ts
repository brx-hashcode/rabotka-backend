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
    const messageSid = body.MessageSid;

    // Twilio delivery status callback: hit the same endpoint as inbound
    // messages but with a MessageStatus. Record end-to-end delivery latency
    // and let the (early-returning) handler run untouched.
    if (body.MessageStatus === 'delivered' && messageSid) {
      void this.sendTiming.recordDelivered(messageSid);
      return next.handle();
    }

    // Genuine inbound message: measure webhook handler time (entry -> 200).
    const start = performance.now();
    const record = (): void =>
      this.sendTiming.observe('handler', 'inbound', performance.now() - start, {
        messageSid,
        to: body.From,
      });

    return next.handle().pipe(tap({ next: record, error: record }));
  }
}
