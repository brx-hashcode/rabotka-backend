import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { I18nService, I18nContext } from 'nestjs-i18n';

@Catch()
@Injectable()
export class I18nExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(I18nExceptionFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message } = this.extractStatusAndMessage(exception);

    if (request.url === '/favicon.ico' && status === 404) {
      response.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    const language = this.getLanguage(request);
    const translatedMessage = this.translateMessage(message, language);

    this.logError(status, translatedMessage, exception);
    this.sendErrorResponse(response, status, translatedMessage, request.url);
  }

  private sendErrorResponse(
    response: Response,
    status: number,
    message: string,
    path: string,
  ): void {
    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path,
    });
  }

  private extractStatusAndMessage(exception: unknown): {
    status: number;
    message: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = this.extractMessageFromHttpException(exception);
      return { status, message };
    }

    if (exception instanceof Error) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: exception.message,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }

  private extractMessageFromHttpException(exception: HttpException): string {
    const exceptionResponse = exception.getResponse();

    if (typeof exceptionResponse === 'string') {
      return exceptionResponse;
    }

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const responseObj = exceptionResponse as any;
      const message =
        responseObj.message || exception.message || 'An error occurred';
      return Array.isArray(message) ? message[0] : message;
    }

    return exception.message;
  }

  private getLanguage(request: Request): string {
    const i18nContext = I18nContext.current();
    if (i18nContext?.lang) {
      return i18nContext.lang;
    }

    const acceptLanguage = request.headers['accept-language'];
    if (acceptLanguage) {
      return acceptLanguage.split(',')[0]?.split('-')[0] || 'en';
    }

    return 'en';
  }

  private isTranslationKey(message: string): boolean {
    return (
      message.includes('.') &&
      !message.startsWith('http') &&
      !message.includes('\\') &&
      !message.includes('/')
    );
  }

  private translateMessage(message: string, language: string): string {
    if (typeof message !== 'string' || !this.isTranslationKey(message)) {
      return message;
    }

    const i18nContext = I18nContext.current();
    if (i18nContext) {
      return this.tryTranslate(() => i18nContext.t(message), message);
    }
    return this.tryTranslate(
      () => this.i18n.t(message, { lang: language }),
      message,
    );
  }

  private tryTranslate(translateFn: () => string, fallback: string): string {
    try {
      return translateFn();
    } catch (translationError) {
      this.logger.warn(
        `Failed to translate error message: ${fallback}. Using original message.`,
        translationError instanceof Error ? translationError.stack : undefined,
      );
      return fallback;
    }
  }

  private logError(status: number, message: string, exception: unknown): void {
    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error(`Exception caught: ${status} - ${message}`, stack);
  }
}
