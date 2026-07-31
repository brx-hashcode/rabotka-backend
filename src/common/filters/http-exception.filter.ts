import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message } = this.extractStatusAndMessage(exception);
    const code = this.extractCode(exception);

    if (request.url === '/favicon.ico' && status === 404) {
      response.status(HttpStatus.NO_CONTENT).end();
      return;
    }

    if (status >= 500) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`Exception: ${status} - ${message}`, stack);
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(code ? { code } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  /**
   * Carries a `code` from the thrown exception through to the response body.
   *
   * This filter rebuilds the body from scratch, so without this any extra field
   * an exception sets is silently dropped — which is how a client ends up
   * unable to tell one 403 from another. Kept generic rather than tied to any
   * single exception type.
   */
  private extractCode(exception: unknown): string | undefined {
    if (!(exception instanceof HttpException)) return undefined;

    const body = exception.getResponse();
    if (typeof body !== 'object' || body === null) return undefined;

    const code = (body as Record<string, unknown>)['code'];
    return typeof code === 'string' ? code : undefined;
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
      message: 'Erreur interne du serveur',
    };
  }

  private extractMessageFromHttpException(exception: HttpException): string {
    const exceptionResponse = exception.getResponse();

    if (typeof exceptionResponse === 'string') {
      return exceptionResponse;
    }

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const responseObj = exceptionResponse as Record<string, unknown>;
      const message =
        responseObj['message'] ||
        exception.message ||
        'Une erreur est survenue';
      return Array.isArray(message)
        ? (message[0] as string)
        : (message as string);
    }

    return exception.message;
  }
}
