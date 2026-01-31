import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const { method, url, ip } = request;

    const userAgent = request.get('user-agent') || '';
    const now = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const response = context.switchToHttp().getResponse();
          const { statusCode } = response;
          const delay = Date.now() - now;

          this.logger.log(
            `${method} ${url} ${statusCode} - ${delay}ms - ${ip} - ${userAgent}`,
          );
        },
        error: (error) => {
          const delay = Date.now() - now;

          const statusCode = error?.status || 500;

          this.logger.error(
            `${method} ${url} ${statusCode} - ${delay}ms - ${ip} - ${userAgent} - ${error.message}`,
          );
        },
      }),
    );
  }
}
