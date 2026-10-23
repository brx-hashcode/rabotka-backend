import { Injectable } from '@nestjs/common';
import { SystemConfigService } from '../system-config/system-config.service';
import { wrapEmailHtml, type EmailLayoutOptions } from './templates/layout';

@Injectable()
export class LayoutService {
  constructor(private readonly systemConfig: SystemConfigService) {}

  /** `product: 'business'` for every email sent to a business account. */
  async wrap(
    content: string,
    options?: Omit<EmailLayoutOptions, 'footer'>,
  ): Promise<string> {
    const footer = await this.systemConfig.getEmailFooterInfo();
    return wrapEmailHtml(content, { ...options, footer });
  }
}
