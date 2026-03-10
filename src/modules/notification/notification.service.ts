import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import {
  adminCreatedEmail,
  adminUpdatedEmail,
  sendOtpEmail,
  sendWelcomeEmail,
} from '../mail/templates';

@Injectable()
export class NotificationService {
  constructor(private readonly mail: MailService) {}

  async notifyAdminCreated(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Bienvenue sur Rabotka – Votre compte administrateur',
      html: adminCreatedEmail(name),
    });
  }

  async notifyAdminUpdated(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Vos informations ont été mises à jour',
      html: adminUpdatedEmail(name),
    });
  }

  async notifyWelcome(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Bienvenue sur Rabotka',
      html: sendWelcomeEmail(name),
    });
  }

  async notifyOtp(to: string, code: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Votre code de vérification Rabotka',
      html: sendOtpEmail(code),
    });
  }
}
