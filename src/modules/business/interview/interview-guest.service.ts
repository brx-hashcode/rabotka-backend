import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InterviewMode, InterviewStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { LayoutService } from '../../mail/layout.service';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { interviewGuestEmail } from './interview-emails';
import { hashToken } from './interview.service';
import { businessPersonName } from './interview-people';

/** Colleagues and managers in one call: more than this is a meeting, not an interview. */
export const MAX_INTERVIEW_GUESTS = 5;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The room part of a visio link made by « Créer un lien de visio ». */
const ROOM_OF = /\/visio\/(Rabotka-[A-Za-z0-9]{6,32})$/;

export type GuestView = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
};

/**
 * « Inviter quelqu'un » in an interview's visio: a colleague, a manager, an
 * outside expert, with no account. Each gets a personal link by e-mail and
 * joins under their own name, as a guest — never as the candidate.
 */
@Injectable()
export class InterviewGuestService {
  private readonly logger = new Logger(InterviewGuestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  async list(profileId: string, interviewId: string): Promise<GuestView[]> {
    await this.owned(profileId, interviewId);
    const rows = await this.prisma.interviewGuest.findMany({
      where: { interview_id: interviewId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map(view);
  }

  async invite(
    profileId: string,
    memberId: string | undefined,
    interviewId: string,
    input: { name: string; email: string },
  ): Promise<GuestView> {
    const interview = await this.owned(profileId, interviewId);
    const room = interview.location?.match(ROOM_OF)?.[1];
    if (
      interview.mode !== InterviewMode.VIDEO ||
      !room ||
      !interview.location
    ) {
      throw new BadRequestException(
        'On invite dans une visio Rabotka : créez un lien de visio pour cet entretien.',
      );
    }
    if (
      interview.status === InterviewStatus.CANCELLED ||
      interview.status === InterviewStatus.DECLINED
    ) {
      throw new BadRequestException('Cet entretien n’a plus lieu.');
    }
    if (
      interview.starts_at.getTime() + interview.duration_minutes * 60_000 <
      Date.now()
    ) {
      throw new BadRequestException('Cet entretien est passé.');
    }
    const name = input.name?.trim().slice(0, 80);
    const email = input.email?.trim().toLowerCase().slice(0, 200);
    if (!name) throw new BadRequestException('Indiquez son nom.');
    if (!email || !EMAIL.test(email)) {
      throw new BadRequestException('Indiquez une adresse e-mail valide.');
    }
    const count = await this.prisma.interviewGuest.count({
      where: { interview_id: interview.id },
    });
    const existing = await this.prisma.interviewGuest.findUnique({
      where: {
        interview_guest_email: { interview_id: interview.id, email },
      },
    });
    if (!existing && count >= MAX_INTERVIEW_GUESTS) {
      throw new BadRequestException(
        `${MAX_INTERVIEW_GUESTS} invités au plus par entretien.`,
      );
    }

    // Invited again: a new link, the old one stops working.
    const token = randomBytes(24).toString('base64url');
    const guest = existing
      ? await this.prisma.interviewGuest.update({
          where: { id: existing.id },
          data: { name, token_hash: hashToken(token) },
        })
      : await this.prisma.interviewGuest.create({
          data: {
            interview_id: interview.id,
            name,
            email,
            token_hash: hashToken(token),
            invited_by_member_id: memberId ?? null,
          },
        });

    const inviter = await businessPersonName(
      this.prisma,
      interview.business_id,
      memberId,
      interview.business.name,
    );
    const invitedBy =
      inviter.name !== interview.business.name
        ? `${inviter.name} (${interview.business.name})`
        : interview.business.name;
    const url = `${interview.location}?g=${encodeURIComponent(token)}`;
    try {
      await this.mail.sendMail({
        to: email,
        subject: `Entretien en visio — ${interview.job_title}`,
        html: await this.layout.wrap(
          interviewGuestEmail(
            {
              businessName: interview.business.name,
              jobTitle: interview.job_title,
              candidateName: interview.candidate_name,
              startsAt: interview.starts_at,
              durationMinutes: interview.duration_minutes,
              mode: interview.mode,
              location: interview.location,
              message: null,
            },
            name,
            url,
            invitedBy,
          ),
          {
            previewText: `${invitedBy} vous invite à un entretien en visio`,
            product: 'business',
          },
        ),
      });
    } catch (err) {
      this.logger.warn(
        `Interview guest mail to ${email} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        'L’invitation n’a pas pu être envoyée. Réessayez dans un instant.',
      );
    }
    return view(guest);
  }

  async remove(profileId: string, interviewId: string, guestId: string) {
    await this.owned(profileId, interviewId);
    const { count } = await this.prisma.interviewGuest.deleteMany({
      where: { id: guestId, interview_id: interviewId },
    });
    if (count === 0) throw new NotFoundException('Invité introuvable.');
    return { removed: true };
  }

  private async owned(profileId: string, interviewId: string) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId)
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    const interview = await this.prisma.interview.findFirst({
      where: { id: interviewId, business_id: businessId },
      include: { business: { select: { name: true } } },
    });
    if (!interview) throw new NotFoundException('Entretien introuvable.');
    return interview;
  }
}

function view(g: {
  id: string;
  name: string;
  email: string;
  created_at: Date;
}): GuestView {
  return {
    id: g.id,
    name: g.name,
    email: g.email,
    createdAt: g.created_at.toISOString(),
  };
}
