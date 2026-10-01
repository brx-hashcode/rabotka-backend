import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator.js';
import { Registry } from 'prom-client';
import { whatsappMetricsRegistry } from './metrics';
import { appMetricsRegistry } from '../../../common/telemetry/metrics';
import { MetricsAccessGuard } from './metrics-access.guard';

@ApiExcludeController()
@Controller()
export class MetricsController {
  // `@Public()` only says there is no SESSION to check: a scraper is not a
  // signed-in user. Who may actually read this is `MetricsAccessGuard`'s call.
  @Public()
  @UseGuards(MetricsAccessGuard)
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): Promise<string> {
    // Merged rather than swapped: the WhatsApp pipeline registry predates the
    // app-wide one and is already being scraped under this path.
    return Registry.merge([
      whatsappMetricsRegistry,
      appMetricsRegistry,
    ]).metrics();
  }
}
