import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ClientErrorReportDto } from './dto/client-error-report.dto';

/**
 * Render errors reported by the web client's error boundary.
 *
 * The app runs mostly inside WhatsApp's in-app browser, where there are no
 * devtools: before this, a crash showed "Une erreur est survenue" and the actual
 * error went to a console nobody could open. This makes it a log line.
 *
 * Public, because the crash can happen before the session is known. CSRF-exempt
 * (see csrf-exempt.ts), because the report is sent with `sendBeacon`, which
 * cannot attach headers. Both are safe here: the endpoint changes no state, and
 * the throttle plus the DTO caps bound what a forged report can do to the logs.
 */
@ApiTags('Client errors')
@Controller('client-errors')
export class ClientErrorsController {
  private readonly logger = new Logger('ClientError');

  @Post()
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Report a render error from the web client' })
  report(@Body() dto: ClientErrorReportDto, @Req() req: Request): void {
    // One JSON line, so the report can be grepped by path or message and the
    // stack stays attached to the error it belongs to.
    this.logger.warn(
      JSON.stringify({
        name: dto.name,
        message: dto.message,
        path: dto.path,
        version: dto.version,
        userAgent: req.headers['user-agent']?.slice(0, 300),
        ip: req.ip,
        stack: dto.stack,
        componentStack: dto.componentStack,
      }),
    );
  }
}
