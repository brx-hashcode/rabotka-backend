import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { SendTimingInterceptor } from '../send-timing.interceptor';
import { SendTimingService } from '../send-timing.service';

function httpContext(req: {
  method: string;
  body?: Record<string, string>;
}): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('SendTimingInterceptor', () => {
  let sendTiming: jest.Mocked<
    Pick<SendTimingService, 'observe' | 'recordDelivered'>
  >;
  let interceptor: SendTimingInterceptor;
  const next: CallHandler = { handle: () => of('ok') };

  beforeEach(() => {
    sendTiming = {
      observe: jest.fn(),
      recordDelivered: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<
      Pick<SendTimingService, 'observe' | 'recordDelivered'>
    >;
    interceptor = new SendTimingInterceptor(
      sendTiming as unknown as SendTimingService,
    );
  });

  it('records delivery latency for a Twilio delivered callback (no handler timing)', async () => {
    const ctx = httpContext({
      method: 'POST',
      body: { MessageStatus: 'delivered', MessageSid: 'SM1' },
    });
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(sendTiming.recordDelivered).toHaveBeenCalledWith('SM1');
    expect(sendTiming.observe).not.toHaveBeenCalled();
  });

  it('measures handlerMs for a genuine inbound message', async () => {
    const ctx = httpContext({
      method: 'POST',
      body: { From: 'whatsapp:+242060000000', Body: 'hi', MessageSid: 'IM1' },
    });
    const result = await lastValueFrom(interceptor.intercept(ctx, next));
    expect(result).toBe('ok');
    expect(sendTiming.recordDelivered).not.toHaveBeenCalled();
    expect(sendTiming.observe).toHaveBeenCalledTimes(1);
    const [stage, direction, duration, meta] = sendTiming.observe.mock.calls[0];
    expect(stage).toBe('handler');
    expect(direction).toBe('inbound');
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(meta).toMatchObject({
      messageSid: 'IM1',
      to: 'whatsapp:+242060000000',
    });
  });

  it('ignores non-POST routes (GET status/verify)', async () => {
    const ctx = httpContext({ method: 'GET' });
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(sendTiming.observe).not.toHaveBeenCalled();
    expect(sendTiming.recordDelivered).not.toHaveBeenCalled();
  });

  it('passes through non-http contexts untouched', async () => {
    const ctx = {
      getType: () => 'ws',
    } as unknown as ExecutionContext;
    const result = await lastValueFrom(interceptor.intercept(ctx, next));
    expect(result).toBe('ok');
    expect(sendTiming.observe).not.toHaveBeenCalled();
  });
});
