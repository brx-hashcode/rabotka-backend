import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FX_RATES_QUEUE } from '../queue/queue.module';
import { QueueService } from '../queue/queue.service';
import { ExchangeRateService } from './exchange-rate.service';

type RefreshJob = { type: 'refresh' };

/**
 * Every six hours: the feeds publish once a day, so four reads keep a missed
 * one from leaving a whole day without rates. Also once at boot, so a fresh
 * database is not without rates until the first tick.
 */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class ExchangeRateScheduler implements OnModuleInit {
  private readonly logger = new Logger(ExchangeRateScheduler.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly rates: ExchangeRateService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker<RefreshJob>(
      FX_RATES_QUEUE,
      async () => {
        const result = await this.rates.refresh();
        if (result) {
          this.logger.log(
            `Exchange rates: ${result.count} currencies from ${result.source}`,
          );
        }
      },
      { concurrency: 1 },
    );

    try {
      const queue = this.queueService.getQueue(FX_RATES_QUEUE);
      await queue.add('refresh', { type: 'refresh' } satisfies RefreshJob, {
        repeat: { every: REFRESH_INTERVAL_MS },
      });
      await queue.add('refresh', { type: 'refresh' } satisfies RefreshJob, {
        jobId: `fx-boot-${new Date().toISOString().slice(0, 13)}`,
      });
    } catch (err) {
      // Rates already stored stay usable until they are too old.
      this.logger.error('Failed to register the exchange-rate refresh', err);
    }
  }
}
