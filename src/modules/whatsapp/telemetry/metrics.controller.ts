import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator.js';
import { whatsappMetricsRegistry } from './metrics';

@ApiExcludeController()
@Controller()
export class MetricsController {
  @Public()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): Promise<string> {
    return whatsappMetricsRegistry.metrics();
  }
}
