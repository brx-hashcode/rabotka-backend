import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  type BusinessMember,
  type BusinessMemberRole,
} from '@prisma/client';

import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { businessDashboardUrl } from '../../mail/audience';
import { LayoutService } from '../../mail/layout.service';
import { MailService } from '../../mail/mail.service';
import {
  businessTeamInviteEmail,
  businessTeamInviteSubject,
} from '../../mail/templates';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';

/** The business and the person behind a business-space request. */
export type TeamActor = {
  businessId: string;
  profileId: string;
  member: BusinessMember;
};

const RESEND_AFTER_MS = 60_000;

/** The roles a business invites: its account holder is its one administrator. */
export type InvitedRole = Extract<BusinessMemberRole, 'RECRUITER' | 'REVIEWER'>;
export const INVITED_ROLES: InvitedRole[] = ['RECRUITER', 'REVIEWER'];

const ROLE_PLURAL: Record<InvitedRole, [string, string]> = {
  RECRUITER: ['recruteur', 'recruteurs'],
  REVIEWER: ['évaluateur', 'évaluateurs'],
};
const ACTIVITY_PAGE = 30;

/** A member as the business space shows it. */
export function memberView(m: BusinessMember) {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    status: m.status,
    isOwner: m.is_owner,
    emailsOn: m.emails_on,
    invitedAt: m.invited_at?.toISOString() ?? null,
    joinedAt: m.joined_at?.toISOString() ?? null,
    lastSeenAt: m.last_seen_at?.toISOString() ?? null,
  };
}

/**
 * The people of a business: the account holder — its one administrator — and
 * the Recruteurs and Évaluateurs it invites, each up to its plan's limit, and
 * who did what. A member signs in with its own e-mail and
 * acts as the business's profile (see AuthService.verifyBusinessOtp); what it
 * may do is `team-access.ts`.
 */
@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
  ) {}

  /** The business, and the token's member or else the account holder. */
  async actor(profileId: string, memberId?: string): Promise<TeamActor> {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    if (!memberId) {
      return { businessId, profileId, member: await this.holder(businessId) };
    }
    const member = await this.prisma.businessMember.findFirst({
      where: { id: memberId, business_id: businessId, status: 'ACTIVE' },
    });
    if (!member) {
      throw new UnauthorizedException('Votre accès à cet espace a été retiré.');
    }
    return { businessId, profileId, member };
  }

  /**
   * The account holder's row, made on first need (a business from before the
   * team, or one that signed up since) and kept on its profile's e-mail.
   */
  async holder(businessId: string): Promise<BusinessMember> {
    const business = await this.prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: {
        name: true,
        created_at: true,
        profile: {
          select: { email: true, first_name: true, last_name: true },
        },
      },
    });
    const email = (business.profile.email ?? '').trim().toLowerCase();
    const found = await this.prisma.businessMember.findFirst({
      where: { business_id: businessId, is_owner: true },
    });
    if (found) {
      if (email && found.email !== email) {
        return this.prisma.businessMember
          .update({ where: { id: found.id }, data: { email } })
          .catch(() => found);
      }
      return found;
    }
    const name =
      [business.profile.first_name, business.profile.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || business.name;
    try {
      return await this.prisma.businessMember.create({
        data: {
          business_id: businessId,
          email,
          name,
          role: 'ADMIN',
          status: 'ACTIVE',
          is_owner: true,
          joined_at: business.created_at,
        },
      });
    } catch (err) {
      // Made meanwhile by a parallel request: read it.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.prisma.businessMember.findFirstOrThrow({
          where: { business_id: businessId, is_owner: true },
        });
      }
      throw err;
    }
  }

  // ── Me ───────────────────────────────────────────────────────────────

  async me(actor: TeamActor) {
    const business = await this.prisma.business.findUniqueOrThrow({
      where: { id: actor.businessId },
      select: { name: true },
    });
    return { ...memberView(actor.member), businessName: business.name };
  }

  async updateMe(actor: TeamActor, dto: { name?: string; emailsOn?: boolean }) {
    const name = dto.name?.trim();
    if (dto.name !== undefined && !name) {
      throw new BadRequestException('Indiquez votre nom.');
    }
    const member = await this.prisma.businessMember.update({
      where: { id: actor.member.id },
      data: {
        ...(name ? { name } : {}),
        ...(dto.emailsOn !== undefined ? { emails_on: dto.emailsOn } : {}),
      },
    });
    return this.me({ ...actor, member });
  }

  // ── The team ─────────────────────────────────────────────────────────

  async list(actor: TeamActor) {
    await this.holder(actor.businessId);
    const [rows, entitlements] = await Promise.all([
      this.prisma.businessMember.findMany({
        where: { business_id: actor.businessId, status: { not: 'REMOVED' } },
        orderBy: [{ is_owner: 'desc' }, { created_at: 'asc' }],
      }),
      this.subscriptions.entitlements(actor.businessId),
    ]);
    return {
      members: rows.map(memberView),
      seats: {
        RECRUITER: {
          used: entitlements.recruiters,
          limit: entitlements.recruitersLimit,
        },
        REVIEWER: {
          used: entitlements.reviewers,
          limit: entitlements.reviewersLimit,
        },
      },
    };
  }

  async invite(
    actor: TeamActor,
    dto: { email: string; name: string; role: InvitedRole },
  ) {
    this.assertAdmin(actor);
    const email = dto.email.trim().toLowerCase();
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Indiquez le nom de la personne.');

    const here = await this.prisma.businessMember.findUnique({
      where: { business_id_email: { business_id: actor.businessId, email } },
    });
    if (here?.is_owner) {
      throw new ConflictException('C’est l’adresse du responsable du compte.');
    }
    if (here && here.status !== 'REMOVED') {
      throw new ConflictException(
        'Cette personne fait déjà partie de l’équipe.',
      );
    }
    const holderElsewhere = await this.prisma.profile.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
        is_business: true,
      },
      select: { id: true },
    });
    if (holderElsewhere) {
      throw new ConflictException(
        'Cette adresse est déjà celle d’un compte entreprise Rabotka.',
      );
    }
    const elsewhere = await this.prisma.businessMember.findFirst({
      where: {
        email,
        business_id: { not: actor.businessId },
        status: { in: ['INVITED', 'ACTIVE'] },
      },
      select: { id: true },
    });
    if (elsewhere) {
      throw new ConflictException(
        'Cette adresse fait déjà partie de l’équipe d’une autre organisation.',
      );
    }

    this.assertInvitedRole(dto.role);
    await this.assertSeat(actor.businessId, dto.role);

    const now = new Date();
    const data = {
      name,
      role: dto.role,
      status: 'INVITED' as const,
      emails_on: dto.role !== 'REVIEWER',
      invited_by_member_id: actor.member.id,
      invited_at: now,
      joined_at: null,
      last_seen_at: null,
      removed_at: null,
    };
    const member = here
      ? await this.prisma.businessMember.update({
          where: { id: here.id },
          data,
        })
      : await this.prisma.businessMember.create({
          data: { ...data, business_id: actor.businessId, email },
        });
    await this.sendInvite(actor.businessId, member, actor.member.name);
    return memberView(member);
  }

  async resend(actor: TeamActor, id: string) {
    this.assertAdmin(actor);
    const member = await this.ownIn(actor.businessId, id);
    if (member.status !== 'INVITED') {
      throw new ConflictException('Cette personne a déjà rejoint l’équipe.');
    }
    if (
      member.invited_at &&
      Date.now() - member.invited_at.getTime() < RESEND_AFTER_MS
    ) {
      throw new HttpException(
        'Invitation envoyée il y a un instant : patientez une minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const updated = await this.prisma.businessMember.update({
      where: { id },
      data: { invited_at: new Date() },
    });
    await this.sendInvite(actor.businessId, updated, actor.member.name);
    return memberView(updated);
  }

  async setRole(actor: TeamActor, id: string, role: InvitedRole) {
    this.assertAdmin(actor);
    this.assertInvitedRole(role);
    const member = await this.ownIn(actor.businessId, id);
    this.assertNotHolderOrSelf(actor, member);
    if (member.role === role) return memberView(member);
    await this.assertSeat(actor.businessId, role);
    const updated = await this.prisma.businessMember.update({
      where: { id },
      data: { role },
    });
    return memberView(updated);
  }

  async remove(actor: TeamActor, id: string) {
    this.assertAdmin(actor);
    const member = await this.ownIn(actor.businessId, id);
    this.assertNotHolderOrSelf(actor, member);
    await this.prisma.businessMember.update({
      where: { id },
      data: { status: 'REMOVED', removed_at: new Date() },
    });
    return { removed: true };
  }

  // ── Admin support ────────────────────────────────────────────────────

  /**
   * Rabotka's team sends an invitation again (rabotka-admin). The same rules
   * as the business's own resend; the admin audit log records it, not the
   * business's activity.
   */
  async resendByAdmin(businessId: string, id: string) {
    const member = await this.ownIn(businessId, id);
    if (member.status !== 'INVITED') {
      throw new ConflictException('This person has already joined the team.');
    }
    if (
      member.invited_at &&
      Date.now() - member.invited_at.getTime() < RESEND_AFTER_MS
    ) {
      throw new HttpException(
        'Invitation sent a moment ago: wait a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const updated = await this.prisma.businessMember.update({
      where: { id },
      data: { invited_at: new Date() },
    });
    await this.sendInvite(businessId, updated, null);
    return memberView(updated);
  }

  /** Rabotka's team removes a member: its sessions stop on their next call. */
  async removeByAdmin(businessId: string, id: string) {
    const member = await this.ownIn(businessId, id);
    if (member.is_owner) {
      throw new ForbiddenException('The account holder cannot be removed.');
    }
    await this.prisma.businessMember.update({
      where: { id },
      data: { status: 'REMOVED', removed_at: new Date() },
    });
    return { removed: true, member: memberView(member) };
  }

  /** The team as admin sees it: removed members too, and who invited whom. */
  async listForAdmin(businessId: string) {
    await this.holder(businessId);
    const [rows, entitlements] = await Promise.all([
      this.prisma.businessMember.findMany({
        where: { business_id: businessId },
        orderBy: [{ is_owner: 'desc' }, { created_at: 'asc' }],
      }),
      this.subscriptions.entitlements(businessId),
    ]);
    const names = new Map(rows.map((r) => [r.id, r.name]));
    return {
      members: rows.map((m) => ({
        ...memberView(m),
        invitedBy: m.invited_by_member_id
          ? (names.get(m.invited_by_member_id) ?? null)
          : null,
        removedAt: m.removed_at?.toISOString() ?? null,
      })),
      seats: {
        RECRUITER: {
          used: entitlements.recruiters,
          limit: entitlements.recruitersLimit,
        },
        REVIEWER: {
          used: entitlements.reviewers,
          limit: entitlements.reviewersLimit,
        },
      },
    };
  }

  // ── Activity ─────────────────────────────────────────────────────────

  /** Records one change; never throws — the change itself already happened. */
  async record(
    businessId: string,
    memberId: string | null,
    action: string,
    targetId: string | null,
  ): Promise<void> {
    await this.prisma.businessActivity
      .create({
        data: {
          business_id: businessId,
          member_id: memberId,
          action,
          target_id: targetId,
        },
      })
      .catch((err) =>
        this.logger.warn(`Activity not recorded: ${String(err)}`),
      );
  }

  async activity(
    actor: Pick<TeamActor, 'businessId'>,
    opts: { page?: number; memberId?: string },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const where = {
      business_id: actor.businessId,
      ...(opts.memberId ? { member_id: opts.memberId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.businessActivity.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * ACTIVITY_PAGE,
        take: ACTIVITY_PAGE,
        include: { member: { select: { id: true, name: true, role: true } } },
      }),
      this.prisma.businessActivity.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.created_at.toISOString(),
        action: r.action,
        targetId: r.target_id,
        member: r.member,
      })),
      page,
      total,
      hasMore: page * ACTIVITY_PAGE < total,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private assertInvitedRole(role: BusinessMemberRole) {
    if (!INVITED_ROLES.includes(role as InvitedRole)) {
      throw new BadRequestException(
        'Le responsable du compte est le seul administrateur : invitez un recruteur ou un évaluateur.',
      );
    }
  }

  /** One more of this role still fits the plan. */
  private async assertSeat(businessId: string, role: InvitedRole) {
    const e = await this.subscriptions.entitlements(businessId);
    const [used, limit] =
      role === 'RECRUITER'
        ? [e.recruiters, e.recruitersLimit]
        : [e.reviewers, e.reviewersLimit];
    if (limit === null || used < limit) return;
    const [one, many] = ROLE_PLURAL[role];
    throw new ForbiddenException(
      limit === 0
        ? `Votre formule n’inclut pas d’${many}. Changez de formule pour en inviter.`
        : `Votre formule permet ${limit} ${limit > 1 ? many : one}. Changez de formule pour en inviter davantage.`,
    );
  }

  private assertAdmin(actor: TeamActor) {
    if (actor.member.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Réservé aux administrateurs de votre organisation.',
      );
    }
  }

  private assertNotHolderOrSelf(actor: TeamActor, member: BusinessMember) {
    if (member.is_owner) {
      throw new ForbiddenException(
        'Le responsable du compte reste administrateur.',
      );
    }
    if (member.id === actor.member.id) {
      throw new ForbiddenException(
        'Un autre administrateur doit faire ce changement pour vous.',
      );
    }
  }

  private async ownIn(businessId: string, id: string) {
    const member = await this.prisma.businessMember.findFirst({
      where: { id, business_id: businessId, status: { not: 'REMOVED' } },
    });
    if (!member) throw new NotFoundException('Membre introuvable.');
    return member;
  }

  /** `invitedBy`: the member's name, or null when Rabotka's team sends it. */
  private async sendInvite(
    businessId: string,
    member: BusinessMember,
    invitedBy: string | null,
  ) {
    const business = await this.prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { name: true },
    });
    const origin = businessDashboardUrl().replace(/\/espace$/, '');
    const signInUrl = `${origin}/auth/sign-in?email=${encodeURIComponent(member.email)}`;
    try {
      await this.mail.sendMail({
        to: member.email,
        subject: businessTeamInviteSubject(business.name),
        html: await this.layout.wrap(
          businessTeamInviteEmail({
            name: member.name,
            invitedBy,
            businessName: business.name,
            role: member.role,
            signInUrl,
          }),
          {
            previewText: businessTeamInviteSubject(business.name),
            product: 'business',
          },
        ),
      });
    } catch (err) {
      this.logger.warn(`Team invitation not sent: ${String(err)}`);
      throw new HttpException(
        'L’invitation n’a pas pu être envoyée. Réessayez dans un instant.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
