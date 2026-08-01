import { Controller, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { AdvertisementService } from '../services/advertisement.service';
import { AdReportService } from '../services/ad-report.service';
import { NotificationService } from '../../notification/notification.service';
import { AdProcessor } from '../services/ad.processor';

const TEST_RECIPIENT = 'blondeau.nbif@gmail.com';

@Controller('dev/advertisements')
export class AdDevController {
  constructor(
    private readonly advertisementService: AdvertisementService,
    private readonly adReportService: AdReportService,
    private readonly notificationService: NotificationService,
    private readonly adProcessor: AdProcessor,
  ) {}

  @Get(':id/send-test-report')
  @HttpCode(HttpStatus.OK)
  async sendTestReport(@Param('id') id: string) {
    const ad = await this.advertisementService.findOne(id);
    const [excelBuffer, analytics] = await Promise.all([
      this.adReportService.generateExcel(id, ad.title),
      this.adReportService.getAnalytics(id),
    ]);
    await this.notificationService.notifyAdvertisementCompleted({
      to: TEST_RECIPIENT,
      adTitle: ad.title,
      startDate: ad.start_date.toISOString(),
      endDate: ad.end_date.toISOString(),
      stats: analytics,
      timeline: analytics.timeline,
      excelBuffer,
    });
    return { sent: true, to: TEST_RECIPIENT, adTitle: ad.title };
  }

  /**
   * Runs a dispatch pass immediately instead of waiting for the 15-minute
   * repeatable job — the only practical way to test a campaign end to end.
   */
  @Get('run-dispatch')
  @HttpCode(HttpStatus.OK)
  async runDispatch() {
    await this.adProcessor.process({ data: { type: 'dispatch' } });
    return { dispatched: true };
  }
}
