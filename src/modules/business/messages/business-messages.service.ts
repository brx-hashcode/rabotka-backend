import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BusinessMessageKind } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { LayoutService } from '../../mail/layout.service';
import { MailService } from '../../mail/mail.service';
import { businessMessageEmail } from '../../mail/templates/external-application';
import { ProfileChatService } from '../../profile-chat/profile-chat.service';
import { detectContacts } from '../../profile-chat/moderation/detect';
import type {
  BulkMessageDto,
  MessageTemplateDto,
} from './dto/message-template.dto';
import { renderTemplate } from './render-template';

/** Templates a business may keep. */
export const MAX_TEMPLATES = 30;

/**
 * Offered while the business has none of that kind: the refusals the space
 * used to hard-code, an invitation, a request for information.
 */
export const SUGGESTED_TEMPLATES: {
  key: string;
  kind: BusinessMessageKind;
  title: string;
  body: string;
}[] = [
  {
    key: 'refusal-filled',
    kind: 'REFUSAL',
    title: 'Poste pourvu',
    body: 'Merci pour votre candidature. Les postes de cette offre sont désormais pourvus. Nous gardons votre profil en tête pour nos prochaines missions.',
  },
  {
    key: 'refusal-profile',
    kind: 'REFUSAL',
    title: 'Profil différent',
    body: 'Merci pour votre candidature. Nous avons retenu des profils plus proches de ce que demande cette mission. Bonne continuation dans vos recherches.',
  },
  {
    key: 'refusal-dates',
    kind: 'REFUSAL',
    title: 'Disponibilités',
    body: "Merci pour votre candidature. Vos disponibilités ne correspondent pas aux dates de cette mission. N'hésitez pas à postuler à nos prochaines offres.",
  },
  {
    key: 'invitation-meet',
    kind: 'INVITATION',
    title: 'Proposer une rencontre',
    body: 'Bonjour {prenom}, votre candidature pour « {poste} » a retenu notre attention. Nous aimerions vous rencontrer : dites-nous quand vous êtes disponible. {entreprise}',
  },
  {
    key: 'information-availability',
    kind: 'INFORMATION',
    title: 'Demander les disponibilités',
    body: 'Bonjour {prenom}, merci pour votre candidature pour « {poste} ». Pourriez-vous nous indiquer vos disponibilités pour les prochaines semaines ? {entreprise}',
  },
];

type Actor = { profileId: string; memberId?: string };

/**
 * « Modèles de messages » and « Envoyer un message » to several candidates
 * of an offer at once. A Rabotka candidate gets it in their conversation
 * with the business (the app, then the usual nudge); a careers-page one by
 * e-mail. Business accounts themselves are never written to on WhatsApp.
 */
@Injectable()
export class BusinessMessagesService {
  private readonly logger = new Logger(BusinessMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ProfileChatService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
  ) {}

  // ── Templates ────────────────────────────────────────────────────────

  async list(profileId: string) {
    const businessId = await this.businessOf(profileId);
    const own = await this.prisma.businessMessageTemplate.findMany({
      where: { business_id: businessId },
      orderBy: [{ kind: 'asc' }, { created_at: 'asc' }],
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        updated_at: true,
        member: { select: { name: true } },
      },
    });
    const kinds = new Set(own.map((t) => t.kind));
    return {
      templates: own.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        body: t.body,
        updatedAt: t.updated_at.toISOString(),
        author: t.member?.name ?? null,
      })),
      // Ready-made ones, for the kinds the business has not written yet.
      suggested: SUGGESTED_TEMPLATES.filter((t) => !kinds.has(t.kind)),
    };
  }

  async create(actor: Actor, dto: MessageTemplateDto) {
    const businessId = await this.businessOf(actor.profileId);
    const count = await this.prisma.businessMessageTemplate.count({
      where: { business_id: businessId },
    });
    if (count >= MAX_TEMPLATES) {
      throw new ConflictException(
        `${MAX_TEMPLATES} modèles au plus : supprimez-en un pour en ajouter un.`,
      );
    }
    const t = await this.prisma.businessMessageTemplate.create({
      data: {
        business_id: businessId,
        member_id: actor.memberId ?? null,
        kind: dto.kind,
        title: dto.title.trim(),
        body: dto.body.trim(),
      },
    });
    return { id: t.id };
  }

  async update(profileId: string, id: string, dto: MessageTemplateDto) {
    await this.owned(profileId, id);
    await this.prisma.businessMessageTemplate.update({
      where: { id },
      data: { kind: dto.kind, title: dto.title.trim(), body: dto.body.trim() },
    });
    return { id };
  }

  async remove(profileId: string, id: string) {
    await this.owned(profileId, id);
    await this.prisma.businessMessageTemplate.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Sending ──────────────────────────────────────────────────────────

  /**
   * One message to several candidatures of an offer, `{prenom}` and the
   * rest filled in for each. A message to a Rabotka candidate may hold no
   * contact details (the contact is obtained, not slipped in a message);
   * checked once, before anyone is written to.
   */
  async send(actor: Actor, offerId: string, dto: BulkMessageDto) {
    const rabotkaIds = dto.rabotka ?? [];
    const externalIds = dto.external ?? [];
    if (rabotkaIds.length + externalIds.length === 0) {
      throw new BadRequestException('Choisissez les candidats.');
    }
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Écrivez votre message.');
    if (rabotkaIds.length > 0 && detectContacts(body).length > 0) {
      throw new BadRequestException(
        'Le message ne peut pas contenir de coordonnées (téléphone, e-mail, lien) : retirez-les.',
      );
    }

    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: actor.profileId, deleted_at: null },
      select: {
        id: true,
        title: true,
        employer: { select: { business: { select: { name: true } } } },
      },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');
    const entreprise = offer.employer.business?.name ?? '';
    const poste = offer.title;

    const [rabotka, external, replyTo] = await Promise.all([
      rabotkaIds.length
        ? this.prisma.application.findMany({
            where: {
              id: { in: rabotkaIds },
              job_offer_id: offer.id,
              deleted_at: null,
            },
            select: { id: true, worker: { select: { first_name: true } } },
          })
        : [],
      externalIds.length
        ? this.prisma.externalApplication.findMany({
            where: { id: { in: externalIds }, job_offer_id: offer.id },
            select: { id: true, first_name: true, email: true },
          })
        : [],
      this.replyAddress(actor),
    ]);

    let sent = 0;
    for (const a of rabotka) {
      try {
        const conversation = await this.chat.openForApplication(
          a.id,
          actor.profileId,
        );
        await this.chat.sendMessage(
          conversation.id,
          actor.profileId,
          renderTemplate(body, {
            prenom: a.worker.first_name ?? '',
            poste,
            entreprise,
          }),
        );
        sent++;
      } catch (err) {
        this.logger.warn(
          `Message to application ${a.id} not sent: ${String(err)}`,
        );
      }
    }
    for (const a of external) {
      try {
        const text = renderTemplate(body, {
          prenom: a.first_name,
          poste,
          entreprise,
        });
        const subject = `Message de ${entreprise || 'votre recruteur'} · ${poste}`;
        await this.mail.sendMail({
          to: a.email,
          subject,
          html: await this.layout.wrap(
            businessMessageEmail({
              firstName: a.first_name,
              businessName: entreprise || 'Le recruteur',
              jobTitle: poste,
              body: text,
              replyTo,
            }),
            { previewText: text.slice(0, 120), product: 'business' },
          ),
        });
        sent++;
      } catch (err) {
        this.logger.warn(
          `Message to careers application ${a.id} not sent: ${String(err)}`,
        );
      }
    }
    return { sent, skipped: rabotkaIds.length + externalIds.length - sent };
  }

  /** Where a careers-page candidate answers: the member who wrote, or the business. */
  private async replyAddress(actor: Actor): Promise<string | null> {
    if (actor.memberId) {
      const member = await this.prisma.businessMember.findUnique({
        where: { id: actor.memberId },
        select: { email: true },
      });
      if (member?.email) return member.email;
    }
    const profile = await this.prisma.profile.findUnique({
      where: { id: actor.profileId },
      select: { email: true },
    });
    return profile?.email ?? null;
  }

  private async businessOf(profileId: string): Promise<string> {
    const business = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      select: { id: true },
    });
    if (!business) throw new NotFoundException('Organisation introuvable.');
    return business.id;
  }

  private async owned(profileId: string, id: string) {
    const businessId = await this.businessOf(profileId);
    const t = await this.prisma.businessMessageTemplate.findFirst({
      where: { id, business_id: businessId },
      select: { id: true },
    });
    if (!t) throw new NotFoundException('Modèle introuvable.');
  }
}
