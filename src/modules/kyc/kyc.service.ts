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

  /**
   * Re-send the KYC approval notification.
   *
   * NOTIFICATION ONLY — deliberately, and unlike the verification path in
   * `admin-profile.controller.ts`, which also delivers the agreement PDF.
   *
   * Sending the agreement here would need `ProfileService`, and importing
   * `ProfileModule` closes a module cycle: ProfileModule → AuthModule → … →
   * KycModule → ProfileModule. `forwardRef` does not resolve it — it moves the
   * undefined import one position along the list — because the loop is real
   * rather than an ordering artefact.
   *
   * An admin who needs the document re-sent can re-run the verification, which
   * does send it. That is a smaller gap than restructuring two large modules.
   */
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
