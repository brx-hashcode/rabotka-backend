import { Logger } from '@nestjs/common';
import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../http-exception.filter';

jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

function makeHost(url: string): {
  host: ArgumentsHost;
  json: jest.Mock;
  status: jest.Mock;
  end: jest.Mock;
} {
  const json = jest.fn();
  const end = jest.fn();
  const statusFn = jest.fn().mockReturnValue({ json, end });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status: statusFn }),
      getRequest: () => ({ url }),
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status: statusFn, end };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  it('responds with 404 status for HttpException', () => {
    const { host, status, json } = makeHost('/some-path');
    filter.catch(new HttpException('Not found', HttpStatus.NOT_FOUND), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Not found',
        path: '/some-path',
      }),
    );
  });

  it('sends 204 No Content for /favicon.ico 404', () => {
    const { host, status, end } = makeHost('/favicon.ico');
    filter.catch(new HttpException('Not Found', HttpStatus.NOT_FOUND), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NO_CONTENT);
    expect(end).toHaveBeenCalled();
  });

  it('responds 500 for generic Error', () => {
    const { host, status, json } = makeHost('/api');
    filter.catch(new Error('Something broke'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        message: 'Erreur interne du serveur',
      }),
    );
  });

  it('keeps the real message out of the response and in the log', () => {
    const { host, json } = makeHost('/api');
    // Already silenced for the whole file above; this is that same spy.
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    errorSpy.mockClear();

    filter.catch(
      new Error('Invalid `prisma.payment.findMany()` invocation: column x'),
      host,
    );

    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('prisma');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('prisma.payment.findMany'),
      expect.anything(),
    );
  });

  it('passes through a 5xx that was written for the caller', () => {
    const { host, status, json } = makeHost('/api');
    filter.catch(
      new HttpException(
        'Le service WhatsApp est indisponible',
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
      host,
    );
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Le service WhatsApp est indisponible',
      }),
    );
  });

  it('responds 500 for unknown exception', () => {
    const { host, status, json } = makeHost('/api');
    filter.catch('some string error', host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
    );
  });

  it('extracts message from object response', () => {
    const { host, json } = makeHost('/api');
    const exception = new HttpException(
      { message: 'Validation failed', error: 'Bad Request' },
      400,
    );
    filter.catch(exception, host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Validation failed' }),
    );
  });

  it('extracts first item when message is an array', () => {
    const { host, json } = makeHost('/api');
    const exception = new HttpException(
      { message: ['field must be a string', 'field is required'] },
      400,
    );
    filter.catch(exception, host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'field must be a string' }),
    );
  });

  it('includes timestamp and path in response', () => {
    const { host, json } = makeHost('/test-path');
    filter.catch(new HttpException('error', 400), host);
    const call = json.mock.calls[0][0];
    expect(call).toHaveProperty('timestamp');
    expect(call.path).toBe('/test-path');
  });

  it('logs error for 5xx exceptions', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'error');
    const { host } = makeHost('/api');
    filter.catch(new HttpException('Server Error', 500), host);
    expect(logSpy).toHaveBeenCalled();
  });

  describe('machine-readable code', () => {
    it('carries a code from the exception body through to the response', () => {
      // This filter rebuilds the body from scratch, so without the passthrough
      // the code is silently dropped and clients cannot tell one 403 apart from
      // another. Guarding it here because the loss is invisible at runtime.
      const { host, json } = makeHost('/job-offers');

      filter.catch(
        new HttpException(
          { message: 'Vérification en cours', code: 'KYC_NOT_VERIFIED' },
          403,
        ),
        host,
      );

      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          code: 'KYC_NOT_VERIFIED',
          message: 'Vérification en cours',
        }),
      );
    });

    it('omits the key entirely when the exception has no code', () => {
      const { host, json } = makeHost('/api');
      filter.catch(new HttpException('plain', 400), host);
      expect(json.mock.calls[0][0]).not.toHaveProperty('code');
    });

    it('ignores a non-string code', () => {
      const { host, json } = makeHost('/api');
      filter.catch(new HttpException({ message: 'x', code: 42 }, 400), host);
      expect(json.mock.calls[0][0]).not.toHaveProperty('code');
    });
  });
  describe('multer failures', () => {
    /** What multer throws: a plain Error with a `name` and a `code`. */
    const multerError = (code: string) =>
      Object.assign(new Error(`multer: ${code}`), {
        name: 'MulterError',
        code,
      });

    it('answers 400 for a file over the size limit', () => {
      // Without the mapping this is a plain Error, so it lands in the generic
      // branch as a 500 — the server blaming itself for an oversize photo, and
      // logging a stack trace on every one.
      const { host, json, status } = makeHost(
        '/api/v1/profile/claims/attachments',
      );

      filter.catch(multerError('LIMIT_FILE_SIZE'), host);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          message: 'Fichier trop volumineux',
        }),
      );
    });

    it('answers 400 for too many files', () => {
      const { host, status } = makeHost('/api');
      filter.catch(multerError('LIMIT_FILE_COUNT'), host);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('answers 400 for an unexpected field', () => {
      const { host, status } = makeHost('/api');
      filter.catch(multerError('LIMIT_UNEXPECTED_FILE'), host);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('leaves an unknown multer code as a 500', () => {
      // A code we have no message for is a bug on our side, not the caller's.
      const { host, status } = makeHost('/api');
      filter.catch(multerError('SOMETHING_NEW'), host);
      expect(status).toHaveBeenCalledWith(500);
    });

    it('does not mistake an ordinary Error carrying a code', () => {
      const { host, status } = makeHost('/api');
      filter.catch(
        Object.assign(new Error('db down'), { code: 'LIMIT_FILE_SIZE' }),
        host,
      );
      expect(status).toHaveBeenCalledWith(500);
    });
  });
});
