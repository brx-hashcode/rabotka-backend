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

    // Multer rejects an oversize or excess file by throwing a plain `Error`
    // carrying a `code`, so without this it lands in the branch below as a 500
    // — the server blaming itself for something the caller did, and logged with
    // a stack trace on every too-big photo. Matched by shape rather than by
    // `instanceof MulterError`: that class lives in multer's own package, which
    // this file has no other reason to depend on.
    const multerStatus = multerErrorStatus(exception);
    if (multerStatus) return multerStatus;

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

/** The multer failures a caller can actually fix, and what to tell them. */
const MULTER_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: 'Fichier trop volumineux',
  LIMIT_FILE_COUNT: 'Trop de fichiers',
  LIMIT_UNEXPECTED_FILE: 'Champ de fichier inattendu',
  LIMIT_PART_COUNT: 'Requête trop volumineuse',
  LIMIT_FIELD_KEY: 'Nom de champ trop long',
  LIMIT_FIELD_VALUE: 'Valeur de champ trop longue',
  LIMIT_FIELD_COUNT: 'Trop de champs',
};

function multerErrorStatus(
  exception: unknown,
): { status: number; message: string } | null {
  if (!(exception instanceof Error) || exception.name !== 'MulterError') {
    return null;
  }

  const code = (exception as Error & { code?: unknown }).code;
  if (typeof code !== 'string') return null;

  const message = MULTER_MESSAGES[code];
  if (!message) return null;

  return { status: HttpStatus.BAD_REQUEST, message };
}
