import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { SystemConfigService } from '../system-config/system-config.service';
import {
  adminCreatedEmail,
  adminUpdatedEmail,
  sendOtpEmail,
  sendWelcomeEmail,
} from '../mail/templates';

@Injectable()
export class NotificationService {
  constructor(
    private readonly mail: MailService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async notifyAdminCreated(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Welcome to Rabotka – Your administrator account',
      html: adminCreatedEmail(name),
    });
  }

  async notifyAdminUpdated(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Your account information has been updated',
      html: adminUpdatedEmail(name),
    });
  }

  async notifyWelcome(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Welcome to Rabotka',
      html: sendWelcomeEmail(name),
    });
  }

  async notifyOtp(to: string, code: string): Promise<void> {
    const supportEmail = await this.systemConfig.get(
      'contact.email',
      'support@rabotka.com',
    );

    await this.mail.sendMail({
      to,
      subject: 'Your Rabotka one-time password',
      html: sendOtpEmail(code, supportEmail),
    });
  }
}
