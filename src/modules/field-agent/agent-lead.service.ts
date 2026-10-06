import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentCallOutcome,
  AgentLeadStatus,
  ApplicationStatus,
  Prisma,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApplicationService } from '../application/application.service';
import { LogService } from '../log/log.service';
import { NotificationDispatcher } from '../notification-dispatch/notification-dispatcher.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { toDigits } from '../whatsapp/contracts/address';
import { notifyAgentPlacement } from './agent-placement';
import { jobsInZonesWhere } from './agent-zones';

/**
 * Congo has one time zone, UTC+1, and no daylight saving — so "today" for the
 * daily reveal cap is a fixed offset rather than a tz database lookup.
 */
const WAT_OFFSET_MS = 60 * 60 * 1000;

export function startOfBrazzavilleDay(now: Date): Date {
  const local = now.getTime() + WAT_OFFSET_MS;
  const day = 24 * 60 * 60 * 1000;
  return new Date(Math.floor(local / day) * day - WAT_OFFSET_MS);
}

/** The worker a lead is about, as an agent may see them — no contact field. */
const LEAD_WORKER_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  avatar_url: true,
  city: true,
} as const satisfies Prisma.ProfileSelect;

const LEAD_SELECT = {
  id: true,
  status: true,
  claimed_by_agent_id: true,
  claimed_at: true,
  claim_expires_at: true,
  invited_at: true,
  invite_expires_at: true,
  application_id: true,
  decided_at: true,
  updated_at: true,
  job_offer: { select: { id: true, title: true, city: true, status: true } },
  worker: { select: LEAD_WORKER_SELECT },
  calls: {
    select: { outcome: true, note: true, created_at: true },
    orderBy: { created_at: 'desc' },
    take: 1,
  },
} as const satisfies Prisma.AgentLeadSelect;

type LeadRow = Prisma.AgentLeadGetPayload<{ select: typeof LEAD_SELECT }>;

/**
 * What a lead looks like from where this agent stands. A claim or invitation
 * past its expiry counts as lapsed, so `available` is the one flag the app
 * needs to show a "Take" button.
 */
export function leadView(row: LeadRow, agentId: string, now = new Date()) {
  const claimLapsed =
    row.status === AgentLeadStatus.CLAIMED &&
    !!row.claim_expires_at &&
    row.claim_expires_at <= now;
  const inviteLapsed =
    row.status === AgentLeadStatus.INVITED &&
    !!row.invite_expires_at &&
    row.invite_expires_at <= now;
  const mine = row.claimed_by_agent_id === agentId;
  const lastCall = row.calls[0];

  return {
    id: row.id,
    status: row.status,
    mine: mine && !claimLapsed,
    available:
      row.status === AgentLeadStatus.SUGGESTED || claimLapsed || inviteLapsed,
    claimExpiresAt: row.claim_expires_at,
    invitedAt: row.invited_at,
    inviteExpiresAt: row.invite_expires_at,
    inviteLapsed,
    applicationId: row.application_id,
    decidedAt: row.decided_at,
    updatedAt: row.updated_at,
    job: {
      id: row.job_offer.id,
      title: row.job_offer.title,
      city: row.job_offer.city,
    },
    worker: {
      id: row.worker.id,
      firstName: row.worker.first_name,
      lastName: row.worker.last_name,
      avatarUrl: row.worker.avatar_url,
      city: row.worker.city,
    },
    lastCall: lastCall
      ? {
          outcome: lastCall.outcome,
          note: lastCall.note,
          at: lastCall.created_at,
        }
      : null,
  };
}

export const AGENT_INVITATION_BUTTON = 'Voir l’offre';

/**
 * The invitation's WhatsApp text — the body of the `agentInvitation` template,
 * also used free-form inside the 24h window and shown to the agent as a
 * preview. The link is the button below it, never in the text.
 */
export function agentInvitationBody(p: {
  workerFirstName: string | null | undefined;
  agentFirstName: string | null | undefined;
  jobTitle: string | null | undefined;
}): string {
  const worker = p.workerFirstName?.trim() || 'à vous';
  const agent = p.agentFirstName?.trim() || 'Votre agent';
  const title = p.jobTitle?.trim() || 'une mission';
  return [
    '*Offre dont vous avez parlé*',
    '',
    `Bonjour ${worker},`,
    '',
    `Suite à votre échange avec ${agent}, agent Rabotka, voici l’offre dont vous avez parlé :`,
    '',
    `*Offre* : ${title}`,
    '',
    'Appuyez ci-dessous pour voir les détails et postuler.',
  ].join('\n');
}

export const AGENT_PLACEMENT_BUTTON = 'Voir ma candidature';

/** The `agentPlacement` template body, also sent free-form in the 24h window. */
export function agentPlacementBody(p: {
  workerFirstName: string | null | undefined;
  agentFirstName: string | null | undefined;
  jobTitle: string | null | undefined;
}): string {
  const worker = p.workerFirstName?.trim() || 'à vous';
  const agent = p.agentFirstName?.trim() || 'Votre agent';
  const title = p.jobTitle?.trim() || 'une mission';
  return [
    '*Candidature enregistrée*',
    '',
    `Bonjour ${worker},`,
    '',
    `Suite à votre appel avec ${agent}, agent Rabotka, votre candidature a été enregistrée :`,
    '',
    `*Offre* : ${title}`,
    '',
    'Appuyez ci-dessous pour suivre votre candidature.',
  ].join('\n');
}

/** Outcomes that end the lead, and the status each one ends it in. */
const CLOSING_OUTCOMES: Partial<Record<AgentCallOutcome, AgentLeadStatus>> = {
  [AgentCallOutcome.NOT_INTERESTED]: AgentLeadStatus.DECLINED,
  [AgentCallOutcome.UNREACHABLE]: AgentLeadStatus.UNREACHABLE,
  [AgentCallOutcome.WRONG_NUMBER]: AgentLeadStatus.UNREACHABLE,
};

/**
 * The agent's pipeline for one (job, worker) pair: claim it, reveal the
 * number, log the calls, send the invitation.
 *
 * Every status change is a conditional `updateMany` on the status it starts
 * from, so two agents racing for the same worker cannot both win, and a
 * retried request cannot apply twice.
 */
@Injectable()
export class AgentLeadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly config: ConfigService,
    private readonly logService: LogService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly applications: ApplicationService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Makes sure a lead exists for each suggested worker and returns how each
   * stands for this agent. Called by the candidates endpoint, so the leads an
   * agent can act on are exactly the workers they were shown.
   */
  async ensureLeads(
    agentId: string,
    jobOfferId: string,
    workerIds: string[],
  ): Promise<Map<string, ReturnType<typeof leadView>>> {
    if (workerIds.length === 0) return new Map();
    await this.prisma.agentLead.createMany({
      data: workerIds.map((worker_id) => ({
        job_offer_id: jobOfferId,
        worker_id,
      })),
      skipDuplicates: true,
    });
    const rows = await this.prisma.agentLead.findMany({
      where: { job_offer_id: jobOfferId, worker_id: { in: workerIds } },
      select: LEAD_SELECT,
    });
    const now = new Date();
    return new Map(rows.map((r) => [r.worker.id, leadView(r, agentId, now)]));
  }

  async claim(agentId: string, leadId: string) {
    await this.loadInZones(agentId, leadId);
    const { claimHours } = await this.systemConfig.getAgentLeadSettings();
    const now = new Date();

    const { count } = await this.prisma.agentLead.updateMany({
      where: {
        id: leadId,
        OR: [
          { status: AgentLeadStatus.SUGGESTED },
          // A lapsed claim or an expired invitation is open again.
          { status: AgentLeadStatus.CLAIMED, claim_expires_at: { lte: now } },
          { status: AgentLeadStatus.INVITED, invite_expires_at: { lte: now } },
          // Already mine: claiming again just renews the lease.
          { status: AgentLeadStatus.CLAIMED, claimed_by_agent_id: agentId },
        ],
      },
      data: {
        status: AgentLeadStatus.CLAIMED,
        claimed_by_agent_id: agentId,
        claimed_at: now,
        claim_expires_at: addHours(now, claimHours),
        invite_token: null,
        invite_expires_at: null,
      },
    });

    if (count === 0) {
      const lead = await this.loadInZones(agentId, leadId);
      throw new ConflictException(
        lead.status === AgentLeadStatus.CLAIMED ||
          lead.status === AgentLeadStatus.INVITED
          ? 'Ce candidat est déjà pris en charge par un autre agent.'
          : 'Ce candidat ne peut plus être pris en charge.',
      );
    }
    return this.view(agentId, leadId);
  }

  /**
   * The worker's numbers, for the claiming agent only. Each reveal is a row;
   * the daily cap counts distinct workers, so looking the same person up again
   * the same day costs nothing.
   */
  async revealPhone(agentId: string, leadId: string, ipAddress?: string) {
    const lead = await this.requireClaim(agentId, leadId);
    const { revealDailyCap } = await this.systemConfig.getAgentLeadSettings();
    const since = startOfBrazzavilleDay(new Date());

    const today = await this.prisma.agentPhoneReveal.findMany({
      where: { agent_id: agentId, created_at: { gte: since } },
      distinct: ['worker_id'],
      select: { worker_id: true },
    });
    const alreadyToday = today.some((r) => r.worker_id === lead.worker_id);
    if (!alreadyToday && today.length >= revealDailyCap) {
      throw new HttpException(
        `Limite atteinte : ${revealDailyCap} numéros par jour. Réessayez demain.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.prisma.agentPhoneReveal.create({
      data: {
        agent_id: agentId,
        lead_id: leadId,
        worker_id: lead.worker_id,
        ip_address: ipAddress ?? null,
      },
    });

    const worker = await this.prisma.profile.findUnique({
      where: { id: lead.worker_id },
      select: { phone: true, direct_phone: true },
    });
    if (!worker) throw new NotFoundException('Travailleur introuvable');

    const used = alreadyToday ? today.length : today.length + 1;
    return {
      phone: worker.phone,
      directPhone: worker.direct_phone,
      revealsLeftToday: Math.max(revealDailyCap - used, 0),
    };
  }

  async logCall(
    agentId: string,
    leadId: string,
    outcome: AgentCallOutcome,
    note?: string,
  ) {
    await this.requireClaim(agentId, leadId);
    const { claimHours } = await this.systemConfig.getAgentLeadSettings();
    const now = new Date();
    const closing = CLOSING_OUTCOMES[outcome];

    await this.prisma.$transaction([
      this.prisma.agentCallLog.create({
        data: {
          lead_id: leadId,
          agent_id: agentId,
          outcome,
          note: note?.trim() || null,
        },
      }),
      closing
        ? this.prisma.agentLead.updateMany({
            where: {
              id: leadId,
              claimed_by_agent_id: agentId,
              status: {
                in: [AgentLeadStatus.CLAIMED, AgentLeadStatus.INVITED],
              },
            },
            data: { status: closing, decided_at: now, invite_token: null },
          })
        : // Still in play: progress renews the lease, so an agent working a
          // worker over several calls does not lose them to a lapse.
          this.prisma.agentLead.updateMany({
            where: {
              id: leadId,
              claimed_by_agent_id: agentId,
              status: AgentLeadStatus.CLAIMED,
            },
            data: { claim_expires_at: addHours(now, claimHours) },
          }),
    ]);

    return this.view(agentId, leadId);
  }

  /**
   * Issues the invitation link the agent sends the worker. A new link
   * replaces the previous one. The pre-filled WhatsApp link (`wa.me`) is
   * offered only once the agent has revealed this worker's number — it
   * contains it.
   */
  async invite(agentId: string, leadId: string) {
    const lead = await this.requireClaim(agentId, leadId);
    const { inviteExpiryHours } =
      await this.systemConfig.getAgentLeadSettings();

    const live = await this.prisma.application.count({
      where: {
        job_offer_id: lead.job_offer_id,
        worker_id: lead.worker_id,
        status: { not: ApplicationStatus.CANCELLED },
        deleted_at: null,
      },
    });
    if (live > 0) {
      throw new ConflictException(
        'Ce travailleur a déjà postulé à cette offre.',
      );
    }

    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = addHours(now, inviteExpiryHours);
    const { count } = await this.prisma.agentLead.updateMany({
      where: {
        id: leadId,
        claimed_by_agent_id: agentId,
        status: { in: [AgentLeadStatus.CLAIMED, AgentLeadStatus.INVITED] },
      },
      data: {
        status: AgentLeadStatus.INVITED,
        invite_token: token,
        invited_at: now,
        invite_expires_at: expiresAt,
      },
    });
    if (count === 0) {
      throw new ConflictException('Ce candidat ne peut plus être invité.');
    }

    const [agent, worker, job, revealed] = await Promise.all([
      this.prisma.agent.findUnique({
        where: { id: agentId },
        select: { first_name: true },
      }),
      this.prisma.profile.findUnique({
        where: { id: lead.worker_id },
        select: { first_name: true, phone: true },
      }),
      this.prisma.jobOffer.findUnique({
        where: { id: lead.job_offer_id },
        select: { title: true, city: true },
      }),
      this.prisma.agentPhoneReveal.count({
        where: { agent_id: agentId, lead_id: leadId },
      }),
    ]);

    const inviteUrl = `${this.frontendUrl()}/invitations/${token}`;
    const message =
      `Bonjour ${worker?.first_name ?? ''}, c'est ${agent?.first_name ?? 'votre agent'} de Rabotka. ` +
      `Voici l'offre dont nous avons parlé : « ${job?.title ?? ''} »` +
      (job?.city ? ` à ${job.city}` : '') +
      `. Pour postuler, ouvrez ce lien : ${inviteUrl}`;

    const sentToWorker = await this.sendToWorker({
      workerId: lead.worker_id,
      phone: worker?.phone ?? null,
      workerFirstName: worker?.first_name,
      agentFirstName: agent?.first_name,
      jobTitle: job?.title,
      invitePath: `invitations/${token}`,
    });

    await this.logService
      .create({
        action: 'AGENT_INVITE_SENT',
        entityType: 'Agent',
        entityId: agentId,
        profileId: lead.worker_id,
        metadata: {
          agentId,
          leadId,
          jobOfferId: lead.job_offer_id,
          sentToWorker,
        },
      })
      .catch(() => undefined);

    return {
      inviteUrl,
      expiresAt,
      message,
      /** The WhatsApp message as the worker sees it: text, then a link button. */
      preview: {
        body: agentInvitationBody({
          workerFirstName: worker?.first_name,
          agentFirstName: agent?.first_name,
          jobTitle: job?.title,
        }),
        buttonText: AGENT_INVITATION_BUTTON,
        url: inviteUrl,
      },
      /** True when Rabotka sent the invitation to the worker by WhatsApp. */
      sentToWorker,
      whatsappUrl:
        revealed > 0 && worker?.phone
          ? `https://wa.me/${toDigits(worker.phone)}?text=${encodeURIComponent(message)}`
          : null,
      lead: await this.view(agentId, leadId),
    };
  }

  /**
   * Places the worker on the job directly: the agent creates the application
   * in the worker's name, credited to them, instead of waiting for the worker
   * to accept an invitation.
   *
   * Only after the agent recorded a call that ended « Intéressé » — the trace
   * that the worker agreed. The application goes through
   * `ApplicationService.create`, so every check the worker would face applying
   * alone still applies. The worker is told by WhatsApp (`agentPlacement`).
   */
  async place(agentId: string, leadId: string) {
    const lead = await this.requireClaim(agentId, leadId);

    const lastCall = await this.prisma.agentCallLog.findFirst({
      where: { lead_id: leadId },
      orderBy: { created_at: 'desc' },
      select: { outcome: true },
    });
    if (lastCall?.outcome !== AgentCallOutcome.INTERESTED) {
      throw new ConflictException(
        'Enregistrez d’abord un appel « Intéressé » avec ce travailleur.',
      );
    }

    // Said in the agent's voice: ApplicationService answers in the worker's.
    const live = await this.prisma.application.count({
      where: {
        job_offer_id: lead.job_offer_id,
        worker_id: lead.worker_id,
        status: { not: ApplicationStatus.CANCELLED },
        deleted_at: null,
      },
    });
    if (live > 0) {
      throw new ConflictException(
        'Ce travailleur a déjà postulé à cette offre.',
      );
    }

    const application = await this.applications.create(
      lead.job_offer_id,
      lead.worker_id,
      { agentId },
    );

    await this.prisma.agentLead.updateMany({
      where: {
        id: leadId,
        claimed_by_agent_id: agentId,
        status: { in: [AgentLeadStatus.CLAIMED, AgentLeadStatus.INVITED] },
      },
      data: {
        status: AgentLeadStatus.CONFIRMED,
        application_id: application.id,
        decided_at: new Date(),
        invite_token: null,
        invite_expires_at: null,
      },
    });

    const [agent, worker, job] = await Promise.all([
      this.prisma.agent.findUnique({
        where: { id: agentId },
        select: { first_name: true },
      }),
      this.prisma.profile.findUnique({
        where: { id: lead.worker_id },
        select: { first_name: true, phone: true },
      }),
      this.prisma.jobOffer.findUnique({
        where: { id: lead.job_offer_id },
        select: { title: true },
      }),
    ]);

    const sentToWorker = await this.sendPlacementToWorker({
      workerId: lead.worker_id,
      phone: worker?.phone ?? null,
      workerFirstName: worker?.first_name,
      agentFirstName: agent?.first_name,
      jobTitle: job?.title,
      applicationPath: `applications/${application.id}`,
    });

    await this.logService
      .create({
        action: 'AGENT_PLACED',
        entityType: 'Agent',
        entityId: agentId,
        profileId: lead.worker_id,
        metadata: {
          agentId,
          leadId,
          jobOfferId: lead.job_offer_id,
          applicationId: application.id,
          sentToWorker,
        },
      })
      .catch(() => undefined);

    await notifyAgentPlacement(
      { prisma: this.prisma, events: this.events },
      {
        agentId,
        agentFirstName: agent?.first_name,
        jobTitle: job?.title ?? '',
        workerId: lead.worker_id,
        applicationId: application.id,
      },
    );

    return {
      applicationId: application.id,
      /** True when Rabotka told the worker by WhatsApp. */
      sentToWorker,
      lead: await this.view(agentId, leadId),
    };
  }

  /**
   * Tells the worker they were placed. Same switch and same fallbacks as the
   * invitation; returns whether WhatsApp accepted the message.
   */
  private async sendPlacementToWorker(p: {
    workerId: string;
    phone: string | null;
    workerFirstName: string | null | undefined;
    agentFirstName: string | null | undefined;
    jobTitle: string | null | undefined;
    applicationPath: string;
  }): Promise<boolean> {
    if (!p.phone) return false;
    if (!(await this.systemConfig.isAgentInviteWhatsAppEnabled())) return false;
    const body = agentPlacementBody(p);
    try {
      const result = await this.dispatcher.send({
        phone: p.phone,
        profileId: p.workerId,
        template: {
          key: 'agentPlacement',
          params: {
            workerFirstName: p.workerFirstName,
            agentFirstName: p.agentFirstName,
            jobTitle: p.jobTitle,
            applicationPath: p.applicationPath,
          },
        },
        freeForm: {
          body,
          buttonText: AGENT_PLACEMENT_BUTTON,
          path: p.applicationPath,
        },
        body,
      });
      return result.sent;
    } catch {
      return false;
    }
  }

  /**
   * Sends the invitation to the worker by WhatsApp when it is switched on
   * (`agent.invite_whatsapp_enabled`, off until Meta approves
   * `rabotka_agent_invitation_v1`). Free-form when the worker's 24h window is
   * open, the template otherwise; the button carries a one-tap login code to
   * the invitation. Never fails the invitation — the agent still has the link.
   */
  private async sendToWorker(p: {
    workerId: string;
    phone: string | null;
    workerFirstName: string | null | undefined;
    agentFirstName: string | null | undefined;
    jobTitle: string | null | undefined;
    invitePath: string;
  }): Promise<boolean> {
    if (!p.phone) return false;
    if (!(await this.systemConfig.isAgentInviteWhatsAppEnabled())) return false;
    const body = agentInvitationBody(p);
    try {
      const result = await this.dispatcher.send({
        phone: p.phone,
        profileId: p.workerId,
        template: {
          key: 'agentInvitation',
          params: {
            workerFirstName: p.workerFirstName,
            agentFirstName: p.agentFirstName,
            jobTitle: p.jobTitle,
            invitePath: p.invitePath,
          },
        },
        freeForm: {
          body,
          buttonText: AGENT_INVITATION_BUTTON,
          path: p.invitePath,
        },
        body,
      });
      return result.sent;
    } catch {
      return false;
    }
  }

  /** The agent's own pipeline, most recently touched first. */
  async listMine(
    agentId: string,
    params: { status?: AgentLeadStatus; page: number; limit: number },
  ) {
    const where: Prisma.AgentLeadWhereInput = {
      claimed_by_agent_id: agentId,
      ...(params.status ? { status: params.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.agentLead.count({ where }),
      this.prisma.agentLead.findMany({
        where,
        select: LEAD_SELECT,
        orderBy: { updated_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);
    const now = new Date();
    return {
      data: rows.map((r) => leadView(r, agentId, now)),
      total,
      page: params.page,
      limit: params.limit,
    };
  }

  // ── admin ─────────────────────────────────────────────────────────────────

  /**
   * An agent's pipeline for the admin: every lead they hold or held, with the
   * full call history, plus how many sit in each status.
   */
  async adminListLeads(
    agentId: string,
    params: { status?: AgentLeadStatus; page: number; limit: number },
  ) {
    const where: Prisma.AgentLeadWhereInput = {
      claimed_by_agent_id: agentId,
      ...(params.status ? { status: params.status } : {}),
    };
    const [total, groups, rows] = await Promise.all([
      this.prisma.agentLead.count({ where }),
      this.prisma.agentLead.groupBy({
        by: ['status'],
        where: { claimed_by_agent_id: agentId },
        _count: { _all: true },
      }),
      this.prisma.agentLead.findMany({
        where,
        select: {
          ...LEAD_SELECT,
          calls: {
            where: { agent_id: agentId },
            select: { id: true, outcome: true, note: true, created_at: true },
            orderBy: { created_at: 'desc' },
          },
          _count: { select: { reveals: { where: { agent_id: agentId } } } },
        },
        orderBy: { updated_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);

    const now = new Date();
    return {
      counts: Object.fromEntries(
        groups.map((g) => [g.status, g._count._all]),
      ) as Partial<Record<AgentLeadStatus, number>>,
      data: rows.map((r) => ({
        ...leadView(r, agentId, now),
        calls: r.calls.map((c) => ({
          id: c.id,
          outcome: c.outcome,
          note: c.note,
          at: c.created_at,
        })),
        revealCount: r._count.reveals,
      })),
      total,
      page: params.page,
      limit: params.limit,
    };
  }

  /** Every phone number the agent looked up, newest first. */
  async adminListReveals(
    agentId: string,
    params: { page: number; limit: number },
  ) {
    const where = { agent_id: agentId };
    const { revealDailyCap } = await this.systemConfig.getAgentLeadSettings();
    const [total, today, rows] = await Promise.all([
      this.prisma.agentPhoneReveal.count({ where }),
      this.prisma.agentPhoneReveal.findMany({
        where: {
          ...where,
          created_at: { gte: startOfBrazzavilleDay(new Date()) },
        },
        distinct: ['worker_id'],
        select: { worker_id: true },
      }),
      this.prisma.agentPhoneReveal.findMany({
        where,
        select: {
          id: true,
          created_at: true,
          ip_address: true,
          worker: { select: LEAD_WORKER_SELECT },
          lead: {
            select: {
              id: true,
              job_offer: { select: { id: true, title: true } },
            },
          },
        },
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);

    return {
      today: today.length,
      dailyCap: revealDailyCap,
      data: rows.map((r) => ({
        id: r.id,
        at: r.created_at,
        ipAddress: r.ip_address,
        worker: {
          id: r.worker.id,
          firstName: r.worker.first_name,
          lastName: r.worker.last_name,
          avatarUrl: r.worker.avatar_url,
        },
        leadId: r.lead.id,
        job: r.lead.job_offer,
      })),
      total,
      page: params.page,
      limit: params.limit,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async view(agentId: string, leadId: string) {
    const row = await this.prisma.agentLead.findUnique({
      where: { id: leadId },
      select: LEAD_SELECT,
    });
    if (!row) throw new NotFoundException('Candidat introuvable');
    return leadView(row, agentId);
  }

  /**
   * The lead, only if its job is open and inside this agent's zones — the same
   * rule as the job routes. Anything else is answered "not found".
   */
  private async loadInZones(agentId: string, leadId: string) {
    const lead = await this.prisma.agentLead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        status: true,
        job_offer_id: true,
        worker_id: true,
        claimed_by_agent_id: true,
        claim_expires_at: true,
      },
    });
    const zones = lead
      ? await this.prisma.agentZone.findMany({
          where: { agent_id: agentId },
          select: { country_code: true, city: true },
        })
      : [];
    const inZones =
      lead && zones.length > 0
        ? await this.prisma.jobOffer.count({
            where: {
              AND: [{ id: lead.job_offer_id }, jobsInZonesWhere(zones)],
            },
          })
        : 0;
    if (!lead || inZones === 0) {
      throw new NotFoundException('Candidat introuvable');
    }
    return lead;
  }

  /** The lead, only for the agent holding a live claim on it. */
  private async requireClaim(agentId: string, leadId: string) {
    const lead = await this.loadInZones(agentId, leadId);
    const live =
      lead.claimed_by_agent_id === agentId &&
      (lead.status === AgentLeadStatus.INVITED ||
        (lead.status === AgentLeadStatus.CLAIMED &&
          !!lead.claim_expires_at &&
          lead.claim_expires_at > new Date()));
    if (!live) {
      throw new ForbiddenException('Prenez d’abord ce candidat en charge.');
    }
    return lead;
  }

  private frontendUrl(): string {
    return (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/, '');
  }
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
