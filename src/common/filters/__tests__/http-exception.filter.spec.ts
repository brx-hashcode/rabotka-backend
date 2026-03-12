import { Logger } from '@nestjs/common';
import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../http-exception.filter';

jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

function makeHost(url: string): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock; end: jest.Mock } {
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
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, message: 'Not found', path: '/some-path' }));
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
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, message: 'Something broke' }));
  });

  it('responds 500 for unknown exception', () => {
    const { host, status, json } = makeHost('/api');
    filter.catch('some string error', host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
  });

  it('extracts message from object response', () => {
    const { host, json } = makeHost('/api');
    const exception = new HttpException({ message: 'Validation failed', error: 'Bad Request' }, 400);
    filter.catch(exception, host);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Validation failed' }));
  });

  it('extracts first item when message is an array', () => {
    const { host, json } = makeHost('/api');
    const exception = new HttpException({ message: ['field must be a string', 'field is required'] }, 400);
    filter.catch(exception, host);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: 'field must be a string' }));
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
});
