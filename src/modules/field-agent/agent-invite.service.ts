import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgentLeadStatus } from '@prisma/client';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ApplicationService } from '../application/application.service';
import { LogService } from '../log/log.service';

/**
 * The worker's side of an agent invitation: the page behind the link the
 * agent sent (`/invitations/:token` in rabotka-client).
 *
 * A token is answered only for the worker it was issued to; anyone else gets
 * "not found", so a forwarded link reveals nothing. Accepting goes through
 * `ApplicationService.create` like any other application — every check the
 * worker would face applying alone still applies — with the agent recorded on
 * the application.
 */
@Injectable()
export class AgentInviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationService,
    private readonly logService: LogService,
    private readonly events: EventEmitter2,
  ) {}

  async get(profileId: string, token: string) {
    const lead = await this.find(profileId, token);
    const job = lead.job_offer;
    return {
      status: lead.status,
      expiresAt: lead.invite_expires_at,
      expired: this.isExpired(lead),
      agent: lead.claimed_by ? { firstName: lead.claimed_by.first_name } : null,
      job: {
        id: job.id,
        reference: job.reference,
        title: job.title,
        description: job.description,
        city: job.city,
        address: job.address,
        scheduledAt: job.scheduled_at,
        amount: job.amount === null ? null : Number(job.amount),
        employmentType: job.employment_type,
        category: job.category,
      },
      applicationId: lead.application_id,
    };
  }

  async accept(profileId: string, token: string) {
    const lead = await this.findOpen(profileId, token);
    const application = await this.applications.create(
      lead.job_offer_id,
      profileId,
      { agentId: lead.claimed_by_agent_id ?? undefined },
    );

    await this.prisma.agentLead.updateMany({
      where: { id: lead.id, status: AgentLeadStatus.INVITED },
      data: {
        status: AgentLeadStatus.CONFIRMED,
        application_id: application.id,
        decided_at: new Date(),
      },
    });
    await this.log('AGENT_INVITE_ACCEPTED', lead, profileId, {
      applicationId: application.id,
    });
    await this.notifyPlacement(lead, profileId, application.id);

    return { success: true, applicationId: application.id };
  }

  async decline(profileId: string, token: string) {
    const lead = await this.findOpen(profileId, token);
    await this.prisma.agentLead.updateMany({
      where: { id: lead.id, status: AgentLeadStatus.INVITED },
      data: { status: AgentLeadStatus.DECLINED, decided_at: new Date() },
    });
    await this.log('AGENT_INVITE_DECLINED', lead, profileId);
    return { success: true };
  }

  /** Tells the admins in the bell; never fails the worker's accept. */
  private async notifyPlacement(
    lead: {
      claimed_by_agent_id: string | null;
      claimed_by: { first_name: string } | null;
      job_offer: { title: string };
    },
    workerId: string,
    applicationId: string,
  ) {
    if (!lead.claimed_by_agent_id) return;
    try {
      const worker = await this.prisma.profile.findUnique({
        where: { id: workerId },
        select: { first_name: true, last_name: true },
      });
      const workerName = worker
        ? `${worker.first_name} ${worker.last_name}`.trim()
        : 'un travailleur';
      this.events.emit(AdminNotificationEvent.AGENT_PLACEMENT, {
        event: AdminNotificationEvent.AGENT_PLACEMENT,
        title: 'Nouveau placement agent',
        message: `${lead.claimed_by?.first_name ?? 'Un agent'} a placé ${workerName} sur « ${lead.job_offer.title} »`,
        entityType: 'agent',
        entityId: lead.claimed_by_agent_id,
        metadata: { applicationId, workerId },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // The placement is recorded; the bell is a courtesy.
    }
  }

  private async find(profileId: string, token: string) {
    const lead = await this.prisma.agentLead.findUnique({
      where: { invite_token: token },
      select: {
        id: true,
        status: true,
        worker_id: true,
        job_offer_id: true,
        claimed_by_agent_id: true,
        invite_expires_at: true,
        application_id: true,
        claimed_by: { select: { first_name: true } },
        job_offer: {
          select: {
            id: true,
            reference: true,
            title: true,
            description: true,
            city: true,
            address: true,
            scheduled_at: true,
            amount: true,
            employment_type: true,
            category: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });
    if (!lead || lead.worker_id !== profileId) {
      throw new NotFoundException('Invitation introuvable');
    }
    return lead;
  }

  /** The lead, only while the invitation can still be answered. */
  private async findOpen(profileId: string, token: string) {
    const lead = await this.find(profileId, token);
    if (lead.status !== AgentLeadStatus.INVITED || this.isExpired(lead)) {
      throw new GoneException("Cette invitation n'est plus valable.");
    }
    return lead;
  }

  private isExpired(lead: { invite_expires_at: Date | null }): boolean {
    return !!lead.invite_expires_at && lead.invite_expires_at <= new Date();
  }

  private log(
    action: string,
    lead: {
      id: string;
      job_offer_id: string;
      claimed_by_agent_id: string | null;
    },
    profileId: string,
    extra: Record<string, unknown> = {},
  ) {
    return this.logService
      .create({
        action,
        entityType: 'Agent',
        entityId: lead.claimed_by_agent_id ?? undefined,
        profileId,
        metadata: {
          agentId: lead.claimed_by_agent_id,
          leadId: lead.id,
          jobOfferId: lead.job_offer_id,
          ...extra,
        },
      })
      .catch(() => undefined);
  }
}
