import { Logger } from '@nestjs/common';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { LoggingInterceptor } from '../logging.interceptor';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

function makeContext(
  method = 'GET',
  url = '/api/test',
  ip = '127.0.0.1',
  statusCode = 200,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        url,
        ip,
        get: jest.fn().mockReturnValue('Mozilla/5.0'),
      }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
  });

  it('passes the request through and logs success', (done) => {
    const logSpy = jest.spyOn(Logger.prototype, 'log');
    const ctx = makeContext('GET', '/health');
    const handler: CallHandler = { handle: () => of({ status: 'ok' }) };

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining('GET /health'),
        );
        done();
      },
    });
  });

  it('logs error on failure', (done) => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const ctx = makeContext('POST', '/api/fail');
    const err = Object.assign(new Error('Oops'), { status: 400 });
    const handler: CallHandler = { handle: () => throwError(() => err) };

    interceptor.intercept(ctx, handler).subscribe({
      error: () => {
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('POST /api/fail'),
        );
        done();
      },
    });
  });

  it('includes status code in log', (done) => {
    const logSpy = jest.spyOn(Logger.prototype, 'log');
    const ctx = makeContext('GET', '/users', '10.0.0.1', 201);
    const handler: CallHandler = { handle: () => of({}) };

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('201'));
        done();
      },
    });
  });

  it('defaults statusCode to 500 when error has no status', (done) => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const ctx = makeContext('DELETE', '/api/resource');
    const err = new Error('Unknown error');
    const handler: CallHandler = { handle: () => throwError(() => err) };

    interceptor.intercept(ctx, handler).subscribe({
      error: () => {
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('500'));
        done();
      },
    });
  });
});
