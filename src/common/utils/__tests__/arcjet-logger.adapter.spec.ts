import { Logger } from '@nestjs/common';
import { createArcjetLoggerAdapter } from '../arcjet-logger.adapter';

describe('createArcjetLoggerAdapter', () => {
  let debugSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates adapter with default context', () => {
    const adapter = createArcjetLoggerAdapter();
    adapter.info('hello');
    expect(logSpy).toHaveBeenCalledWith('hello');
  });

  it('creates adapter with custom context', () => {
    const adapter = createArcjetLoggerAdapter('CustomCtx');
    adapter.debug('test');
    expect(debugSpy).toHaveBeenCalledWith('test');
  });

  describe('debug', () => {
    it('logs string message', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.debug('msg');
      expect(debugSpy).toHaveBeenCalledWith('msg');
    });

    it('logs object message with string msg', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.debug({ foo: 'bar' }, 'label');
      expect(debugSpy).toHaveBeenCalledWith('label');
    });

    it('formats string with args', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.debug('hello %s', 'world');
      expect(debugSpy).toHaveBeenCalledWith('hello world');
    });
  });

  describe('info', () => {
    it('calls logger.log', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.info('info message');
      expect(logSpy).toHaveBeenCalledWith('info message');
    });

    it('formats with multiple args', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.info('%s %s', 'hello', 'world');
      expect(logSpy).toHaveBeenCalledWith('hello world');
    });
  });

  describe('warn', () => {
    it('calls logger.warn', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.warn('warning');
      expect(warnSpy).toHaveBeenCalledWith('warning');
    });
  });

  describe('error', () => {
    it('calls logger.error', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.error('error msg');
      expect(errorSpy).toHaveBeenCalledWith('error msg');
    });
  });

  describe('formatArcjetMessage edge cases', () => {
    it('returns template when no valid args', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.debug('bare message', undefined);
      expect(debugSpy).toHaveBeenCalledWith('bare message');
    });

    it('handles object msgOrObj with no msg', () => {
      const adapter = createArcjetLoggerAdapter();
      adapter.debug({ foo: 'bar' });
      expect(debugSpy).toHaveBeenCalledWith('');
    });
  });
});
