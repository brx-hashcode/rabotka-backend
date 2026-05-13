import { Controller, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { AdvertisementService } from '../services/advertisement.service';
import { AdReportService } from '../services/ad-report.service';
import { NotificationService } from '../../notification/notification.service';

const TEST_RECIPIENT = 'blondeau.nbif@gmail.com';

@Controller('dev/advertisements')
export class AdDevController {
  constructor(
    private readonly advertisementService: AdvertisementService,
    private readonly adReportService: AdReportService,
    private readonly notificationService: NotificationService,
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
}
