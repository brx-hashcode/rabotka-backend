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
      timestamp: new Date().toISOString(),
      path: request.url,
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
