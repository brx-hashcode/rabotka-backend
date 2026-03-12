import { Logger, HttpException, HttpStatus } from '@nestjs/common';
import { I18nExceptionFilter } from '../i18n-exception.filter';

jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

// Suppress I18nContext.current() calls
jest.mock('nestjs-i18n', () => ({
  I18nContext: { current: jest.fn().mockReturnValue(null) },
  I18nService: class {},
}));

function makeI18n() {
  return { t: jest.fn().mockImplementation((key: string) => `translated:${key}`) };
}

function makeHost(overrides: Record<string, unknown> = {}) {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  };
  const request = {
    url: '/api/test',
    headers: {},
    ...overrides,
  };
  return {
    switchToHttp: jest.fn().mockReturnValue({
      getResponse: jest.fn().mockReturnValue(response),
      getRequest: jest.fn().mockReturnValue(request),
    }),
    response,
    request,
  };
}

describe('I18nExceptionFilter', () => {
  let filter: I18nExceptionFilter;
  let i18n: ReturnType<typeof makeI18n>;

  beforeEach(() => {
    i18n = makeI18n();
    filter = new I18nExceptionFilter(i18n as any);
  });

  it('handles HttpException with correct status', () => {
    const host = makeHost();
    filter.catch(new HttpException('Not Found', 404), host as any);
    expect(host.response.status).toHaveBeenCalledWith(404);
    expect(host.response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, message: 'Not Found' }),
    );
  });

  it('handles HttpException with object response', () => {
    const host = makeHost();
    filter.catch(
      new HttpException({ message: 'Validation failed', error: 'Bad Request' }, 400),
      host as any,
    );
    expect(host.response.status).toHaveBeenCalledWith(400);
  });

  it('handles HttpException with array message', () => {
    const host = makeHost();
    filter.catch(
      new HttpException({ message: ['field is required', 'name too short'] }, 422),
      host as any,
    );
    expect(host.response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'field is required' }),
    );
  });

  it('handles generic Error as 500', () => {
    const host = makeHost();
    filter.catch(new Error('Unexpected failure'), host as any);
    expect(host.response.status).toHaveBeenCalledWith(500);
    expect(host.response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, message: 'Unexpected failure' }),
    );
  });

  it('handles unknown non-Error exception as 500', () => {
    const host = makeHost();
    filter.catch('string error', host as any);
    expect(host.response.status).toHaveBeenCalledWith(500);
  });

  it('returns 204 for favicon.ico 404', () => {
    const host = makeHost({ url: '/favicon.ico' });
    filter.catch(new HttpException('Not Found', 404), host as any);
    expect(host.response.status).toHaveBeenCalledWith(204);
    expect(host.response.end).toHaveBeenCalled();
  });

  it('includes timestamp and path in response', () => {
    const host = makeHost({ url: '/api/v1/test' });
    filter.catch(new HttpException('Error', 500), host as any);
    expect(host.response.json).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/v1/test', timestamp: expect.any(String) }),
    );
  });

  it('reads accept-language header for language', () => {
    const host = makeHost({ url: '/api/test', headers: { 'accept-language': 'fr-FR,fr;q=0.9' } });
    filter.catch(new HttpException('Error', 400), host as any);
    expect(host.response.status).toHaveBeenCalledWith(400);
  });

  it('translates dotted message keys using i18n', () => {
    const host = makeHost();
    filter.catch(new HttpException('errors.not_found', 404), host as any);
    expect(i18n.t).toHaveBeenCalledWith('errors.not_found', expect.anything());
  });

  it('does not translate plain string messages', () => {
    const host = makeHost();
    filter.catch(new HttpException('Simple message', 400), host as any);
    // i18n.t should NOT be called for non-dotted keys
    expect(i18n.t).not.toHaveBeenCalled();
  });

  it('falls back to original message when translation throws', () => {
    i18n.t.mockImplementationOnce(() => { throw new Error('i18n error'); });
    const host = makeHost();
    filter.catch(new HttpException('errors.some_key', 400), host as any);
    // Should not throw — falls back to original key
    expect(host.response.json).toHaveBeenCalled();
  });
});
