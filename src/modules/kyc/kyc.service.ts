import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WHATSAPP_TEMPLATES } from '../../common/constants/whatsapp-templates';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsApp: WhatsAppService,
  ) {}

  async approveKyc(profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, first_name: true, last_name: true, phone: true },
    });

    if (!profile) {
      throw new NotFoundException('Profil introuvable');
    }

    const name = [profile.first_name, profile.last_name]
      .filter(Boolean)
      .join(' ');

    const sent = await this.whatsApp.sendTemplateMessage(
      profile.phone,
      'kyc',
      name,
      profile.id,
    );

    if (!sent) {
      throw new Error("Echec de l'envoi du message WhatsApp");
    }

    this.logger.log(
      `KYC approved for profile ${profileId}, WhatsApp approval message sent`,
    );
  }
}
