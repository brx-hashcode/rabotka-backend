import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { AgentCallOutcome, AgentLeadStatus, Prisma } from '@prisma/client';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';
import {
  AgentLeadService,
  leadView,
  startOfBrazzavilleDay,
} from '../agent-lead.service';

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + HOUR);
const past = () => new Date(Date.now() - HOUR);

function leadRow(over: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    status: AgentLeadStatus.SUGGESTED,
    claimed_by_agent_id: null,
    claimed_at: null,
    claim_expires_at: null,
    invited_at: null,
    invite_expires_at: null,
    application_id: null,
    decided_at: null,
    updated_at: new Date(),
    job_offer: {
      id: 'job-1',
      title: 'Plombier',
      city: 'Brazzaville',
      status: 'ACTIVE',
    },
    worker: {
      id: 'w1',
      first_name: 'Awa',
      last_name: 'K',
      avatar_url: null,
      city: 'Brazzaville',
    },
    calls: [],
    ...over,
  };
}

/** The lead as loadInZones reads it. */
function bareLead(over: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    status: AgentLeadStatus.CLAIMED,
    job_offer_id: 'job-1',
    worker_id: 'w1',
    claimed_by_agent_id: 'agent-1',
    claim_expires_at: future(),
    ...over,
  };
}

describe('startOfBrazzavilleDay', () => {
  it('starts the day at midnight UTC+1', () => {
    // 23:30 UTC is 00:30 the next day in Brazzaville.
    expect(
      startOfBrazzavilleDay(new Date('2026-10-02T23:30:00Z')).toISOString(),
    ).toBe('2026-10-02T23:00:00.000Z');
    expect(
      startOfBrazzavilleDay(new Date('2026-10-02T22:30:00Z')).toISOString(),
    ).toBe('2026-10-01T23:00:00.000Z');
  });
});

describe('leadView', () => {
  it('offers a lapsed claim to anyone and stops calling it mine', () => {
    const view = leadView(
      leadRow({
        status: AgentLeadStatus.CLAIMED,
        claimed_by_agent_id: 'agent-1',
        claim_expires_at: past(),
      }) as any,
      'agent-1',
    );
    expect(view).toMatchObject({ mine: false, available: true });
  });

  it('shows a live claim as mine to its holder and unavailable to others', () => {
    const row = leadRow({
      status: AgentLeadStatus.CLAIMED,
      claimed_by_agent_id: 'agent-1',
      claim_expires_at: future(),
    }) as any;
    expect(leadView(row, 'agent-1')).toMatchObject({
      mine: true,
      available: false,
    });
    expect(leadView(row, 'agent-2')).toMatchObject({
      mine: false,
      available: false,
    });
  });

  it('never carries a contact field', () => {
    const view = leadView(leadRow() as any, 'agent-1');
    for (const field of ['phone', 'directPhone', 'email']) {
      expect(view.worker).not.toHaveProperty(field);
    }
  });
});

describe('AgentLeadService', () => {
  let prisma: any;
  let systemConfig: {
    getAgentLeadSettings: jest.Mock;
    isAgentInviteWhatsAppEnabled: jest.Mock;
  };
  let dispatcher: { send: jest.Mock };
  let logService: { create: jest.Mock };
  let applications: { create: jest.Mock };
  let events: { emit: jest.Mock };
  let service: AgentLeadService;

  beforeEach(() => {
    prisma = {
      agentLead: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      agentZone: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ country_code: 'CG', city: 'Brazzaville' }]),
      },
      jobOffer: {
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest
          .fn()
          .mockResolvedValue({ title: 'Plombier', city: 'Brazzaville' }),
      },
      agentPhoneReveal: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      agentCallLog: {
        create: jest.fn().mockReturnValue('call-op'),
        findFirst: jest.fn().mockResolvedValue({ outcome: 'INTERESTED' }),
      },
      profile: {
        findUnique: jest.fn().mockResolvedValue({
          first_name: 'Awa',
          phone: '+242061234567',
          direct_phone: null,
        }),
      },
      agent: {
        findUnique: jest.fn().mockResolvedValue({ first_name: 'Jean' }),
      },
      application: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    // First read is loadInZones (bare), later ones the full view.
    prisma.agentLead.findUnique.mockImplementation(({ select }: any) =>
      Promise.resolve(select.job_offer_id ? bareLead() : leadRow()),
    );
    systemConfig = {
      getAgentLeadSettings: jest.fn().mockResolvedValue({
        revealDailyCap: 2,
        claimHours: 24,
        inviteExpiryHours: 48,
      }),
      isAgentInviteWhatsAppEnabled: jest.fn().mockResolvedValue(false),
    };
    dispatcher = {
      send: jest.fn().mockResolvedValue({ mode: 'TEMPLATE', sent: true }),
    };
    logService = { create: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue('https://rabotka.work/') };
    applications = { create: jest.fn().mockResolvedValue({ id: 'app-1' }) };
    events = { emit: jest.fn() };
    service = new AgentLeadService(
      prisma,
      systemConfig as any,
      config as any,
      logService as any,
      dispatcher as any,
      applications as any,
      events as any,
    );
  });

  const onLoad = (over: Record<string, unknown>) =>
    prisma.agentLead.findUnique.mockImplementation(({ select }: any) =>
      Promise.resolve(select.job_offer_id ? bareLead(over) : leadRow()),
    );

  describe('ensureLeads', () => {
    it('creates missing leads without touching existing ones', async () => {
      await service.ensureLeads('agent-1', 'job-1', ['w1', 'w2']);
      expect(prisma.agentLead.createMany).toHaveBeenCalledWith({
        data: [
          { job_offer_id: 'job-1', worker_id: 'w1' },
          { job_offer_id: 'job-1', worker_id: 'w2' },
        ],
        skipDuplicates: true,
      });
    });

    it('does nothing for an empty list', async () => {
      const result = await service.ensureLeads('agent-1', 'job-1', []);
      expect(result.size).toBe(0);
      expect(prisma.agentLead.createMany).not.toHaveBeenCalled();
    });
  });

  describe('claim', () => {
    it('only takes a lead that is free, lapsed, or already mine', async () => {
      await service.claim('agent-1', 'lead-1');
      const { where, data } = prisma.agentLead.updateMany.mock.calls[0][0];
      expect(where.id).toBe('lead-1');
      expect(where.OR).toEqual(
        expect.arrayContaining([
          { status: AgentLeadStatus.SUGGESTED },
          { status: AgentLeadStatus.CLAIMED, claimed_by_agent_id: 'agent-1' },
        ]),
      );
      expect(data).toMatchObject({
        status: AgentLeadStatus.CLAIMED,
        claimed_by_agent_id: 'agent-1',
        invite_token: null,
      });
      expect(data.claim_expires_at.getTime() - data.claimed_at.getTime()).toBe(
        24 * HOUR,
      );
    });

    it('loses the race with a 409 when another agent got there first', async () => {
      prisma.agentLead.updateMany.mockResolvedValue({ count: 0 });
      onLoad({ claimed_by_agent_id: 'agent-2' });
      await expect(service.claim('agent-1', 'lead-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('answers 404 for a lead whose job is outside the zones', async () => {
      prisma.jobOffer.count.mockResolvedValue(0);
      await expect(service.claim('agent-1', 'lead-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.agentLead.updateMany).not.toHaveBeenCalled();
    });

    it('answers 404 to an agent with no zone', async () => {
      prisma.agentZone.findMany.mockResolvedValue([]);
      await expect(service.claim('agent-1', 'lead-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('revealPhone', () => {
    it('still shows the number of a worker this agent placed', async () => {
      onLoad({ status: AgentLeadStatus.CONFIRMED, claim_expires_at: null });
      const result = await service.revealPhone('agent-1', 'lead-1');
      expect(result.phone).toBe('+242061234567');
    });

    it('refuses the number of a worker another agent placed', async () => {
      onLoad({
        status: AgentLeadStatus.CONFIRMED,
        claimed_by_agent_id: 'agent-2',
      });
      await expect(service.revealPhone('agent-1', 'lead-1')).rejects.toThrow(
        'Prenez d’abord',
      );
    });

    it('returns the numbers and logs the reveal', async () => {
      const result = await service.revealPhone('agent-1', 'lead-1', '1.2.3.4');
      expect(result).toEqual({
        phone: '+242061234567',
        directPhone: null,
        revealsLeftToday: 1,
      });
      expect(prisma.agentPhoneReveal.create).toHaveBeenCalledWith({
        data: {
          agent_id: 'agent-1',
          lead_id: 'lead-1',
          worker_id: 'w1',
          ip_address: '1.2.3.4',
        },
      });
    });

    it('refuses a new worker once the daily cap is reached', async () => {
      prisma.agentPhoneReveal.findMany.mockResolvedValue([
        { worker_id: 'w8' },
        { worker_id: 'w9' },
      ]);
      await expect(service.revealPhone('agent-1', 'lead-1')).rejects.toThrow(
        HttpException,
      );
      expect(prisma.agentPhoneReveal.create).not.toHaveBeenCalled();
    });

    it('lets the agent look the same worker up again past the cap', async () => {
      prisma.agentPhoneReveal.findMany.mockResolvedValue([
        { worker_id: 'w1' },
        { worker_id: 'w9' },
      ]);
      const result = await service.revealPhone('agent-1', 'lead-1');
      expect(result.revealsLeftToday).toBe(0);
    });

    it('is for the claimer only', async () => {
      onLoad({ claimed_by_agent_id: 'agent-2' });
      await expect(service.revealPhone('agent-1', 'lead-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses once the claim has lapsed', async () => {
      onLoad({ claim_expires_at: past() });
      await expect(service.revealPhone('agent-1', 'lead-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('logCall', () => {
    it.each([
      [AgentCallOutcome.NOT_INTERESTED, AgentLeadStatus.DECLINED],
      [AgentCallOutcome.UNREACHABLE, AgentLeadStatus.UNREACHABLE],
      [AgentCallOutcome.WRONG_NUMBER, AgentLeadStatus.UNREACHABLE],
    ])('closes the lead on %s', async (outcome, status) => {
      await service.logCall('agent-1', 'lead-1', outcome, ' pas dispo ');
      expect(prisma.agentCallLog.create).toHaveBeenCalledWith({
        data: {
          lead_id: 'lead-1',
          agent_id: 'agent-1',
          outcome,
          note: 'pas dispo',
        },
      });
      expect(prisma.agentLead.updateMany.mock.calls[0][0].data).toMatchObject({
        status,
      });
    });

    it('renews the claim on a call that keeps the lead going', async () => {
      await service.logCall('agent-1', 'lead-1', AgentCallOutcome.INTERESTED);
      const { data } = prisma.agentLead.updateMany.mock.calls[0][0];
      expect(data).not.toHaveProperty('status');
      expect(data.claim_expires_at.getTime()).toBeGreaterThan(
        Date.now() + 23 * HOUR,
      );
    });
  });

  describe('invite — WhatsApp to the worker', () => {
    it('sends nothing while the setting is off', async () => {
      const result = await service.invite('agent-1', 'lead-1');
      expect(result.sentToWorker).toBe(false);
      expect(dispatcher.send).not.toHaveBeenCalled();
    });

    it('sends the template, its button opening the invitation, when on', async () => {
      systemConfig.isAgentInviteWhatsAppEnabled.mockResolvedValue(true);
      const result = await service.invite('agent-1', 'lead-1');

      expect(result.sentToWorker).toBe(true);
      const call = dispatcher.send.mock.calls[0][0];
      const token = result.inviteUrl.split('/').pop();
      expect(call).toMatchObject({
        phone: '+242061234567',
        profileId: 'w1',
        template: {
          key: 'agentInvitation',
          params: {
            workerFirstName: 'Awa',
            agentFirstName: 'Jean',
            jobTitle: 'Plombier',
            invitePath: `invitations/${token}`,
          },
        },
        freeForm: { buttonText: 'Voir l’offre', path: `invitations/${token}` },
      });
    });

    it('never hands Meta an empty variable, whatever is missing', () => {
      const vars = WHATSAPP_TEMPLATES.agentInvitation.variables({
        workerFirstName: null,
        agentFirstName: '  ',
        jobTitle: undefined,
        invitePath: 'invitations/t',
      });
      expect(vars).toEqual({
        '1': 'à vous',
        '2': 'Votre agent',
        '3': 'une mission',
        '4': 'invitations/t',
      });
    });

    it('still issues the invitation when the send fails', async () => {
      systemConfig.isAgentInviteWhatsAppEnabled.mockResolvedValue(true);
      dispatcher.send.mockRejectedValue(new Error('provider down'));
      const result = await service.invite('agent-1', 'lead-1');
      expect(result.sentToWorker).toBe(false);
      expect(result.inviteUrl).toContain('/invitations/');
    });
  });

  describe('place', () => {
    it('creates the application credited to the agent and confirms the lead', async () => {
      const result = await service.place('agent-1', 'lead-1');

      expect(applications.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { agentId: 'agent-1' },
      );
      const update = prisma.agentLead.updateMany.mock.calls.at(-1)[0];
      expect(update.where).toMatchObject({
        id: 'lead-1',
        claimed_by_agent_id: 'agent-1',
      });
      expect(update.data).toMatchObject({
        status: 'CONFIRMED',
        application_id: 'app-1',
      });
      expect(result.applicationId).toBe('app-1');
      expect(events.emit).toHaveBeenCalledWith(
        'admin.notification.agent.placement',
        expect.objectContaining({ entityId: 'app-1' }),
      );
    });

    it('refuses without a last call « Intéressé »', async () => {
      prisma.agentCallLog.findFirst.mockResolvedValue({ outcome: 'CALL_BACK' });
      await expect(service.place('agent-1', 'lead-1')).rejects.toThrow(
        'Intéressé',
      );
      expect(applications.create).not.toHaveBeenCalled();
    });

    // Pentest A2-F13 (#869): another agent's « Intéressé » let the next
    // claimer place the worker and take the commission.
    it('only counts this agent’s own call as consent', async () => {
      await service.place('agent-1', 'lead-1');

      expect(prisma.agentCallLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lead_id: 'lead-1', agent_id: 'agent-1' },
        }),
      );
    });

    it('refuses, in the agent’s voice, when the worker already applied', async () => {
      prisma.application.count.mockResolvedValue(1);
      await expect(service.place('agent-1', 'lead-1')).rejects.toThrow(
        'Ce travailleur a déjà postulé',
      );
      expect(applications.create).not.toHaveBeenCalled();
    });

    it('tells the worker by WhatsApp, linking their application', async () => {
      systemConfig.isAgentInviteWhatsAppEnabled.mockResolvedValue(true);
      const result = await service.place('agent-1', 'lead-1');
      const sent = dispatcher.send.mock.calls[0][0];
      expect(sent.template).toMatchObject({
        key: 'agentPlacement',
        params: { applicationPath: 'applications/app-1' },
      });
      expect(sent.freeForm.buttonText).toBe('Voir ma candidature');
      expect(result.sentToWorker).toBe(true);
    });
  });

  describe('listPlacements', () => {
    const placement = (over: Record<string, unknown> = {}) => ({
      id: 'app-2',
      status: 'ACCEPTED',
      created_at: new Date('2026-10-05T10:00:00Z'),
      updated_at: new Date('2026-10-05T12:00:00Z'),
      worker: {
        id: 'w2',
        first_name: 'Awa',
        last_name: 'Mabiala',
        avatar_url: null,
        city: 'Brazzaville',
      },
      job_offer: { id: 'job-1', title: 'Serveuse', city: 'Brazzaville' },
      agent_lead: { id: 'lead-2' },
      ...over,
    });

    beforeEach(() => {
      prisma.application.findMany = jest.fn().mockResolvedValue([placement()]);
      prisma.application.count = jest.fn().mockResolvedValue(1);
      prisma.agentCommission = {
        findMany: jest.fn().mockResolvedValue([]),
      };
    });

    it('lists the applications credited to this agent on the job, newest first', async () => {
      const result = await service.listPlacements('agent-1', 'job-1');
      const query = prisma.application.findMany.mock.calls[0][0];
      expect(query.where).toEqual({
        job_offer_id: 'job-1',
        agent_id: 'agent-1',
        deleted_at: null,
      });
      expect(query.orderBy).toEqual({ created_at: 'desc' });
      expect(result).toEqual([
        expect.objectContaining({
          applicationId: 'app-2',
          status: 'ACCEPTED',
          leadId: 'lead-2',
          job: { id: 'job-1', title: 'Serveuse', city: 'Brazzaville' },
          worker: expect.objectContaining({ firstName: 'Awa' }),
          commission: null,
        }),
      ]);
      expect(result[0].worker).not.toHaveProperty('phone');
    });

    it('rejects a job outside the zones', async () => {
      prisma.jobOffer.count.mockResolvedValue(0);
      await expect(service.listPlacements('agent-1', 'job-1')).rejects.toThrow(
        'Offre introuvable',
      );
    });

    it('lists every job, paged, with the commission each placement earned', async () => {
      prisma.agentCommission.findMany.mockResolvedValue([
        {
          application_id: 'app-2',
          status: 'PENDING',
          amount: new Prisma.Decimal(400),
          available_at: null,
          reason: null,
        },
      ]);
      const result = await service.listAllPlacements('agent-1', {
        page: 2,
        limit: 10,
      });
      const query = prisma.application.findMany.mock.calls[0][0];
      expect(query.where).toEqual({ agent_id: 'agent-1', deleted_at: null });
      expect(query.skip).toBe(10);
      expect(prisma.jobOffer.count).not.toHaveBeenCalled();
      expect(result).toMatchObject({ total: 1, page: 2, limit: 10 });
      expect(result.data[0].commission).toEqual({
        status: 'PENDING',
        amount: 400,
        availableAt: null,
        reason: null,
      });
    });

    it('filters by group of application statuses', async () => {
      await service.listAllPlacements('agent-1', {
        group: 'closed',
        page: 1,
        limit: 20,
      });
      expect(prisma.application.findMany.mock.calls[0][0].where.status).toEqual(
        { in: ['REJECTED', 'CANCELLED'] },
      );
    });
  });

  describe('off-list workers (by WhatsApp number)', () => {
    const worker = (over: Record<string, unknown> = {}) => ({
      id: 'worker-9',
      first_name: 'Awa',
      last_name: 'mabiala',
      avatar_url: null,
      city: 'Brazzaville',
      status: 'ACTIVE',
      profile_type: 'WORKER',
      verification_status: 'VERIFIED',
      ...over,
    });

    beforeEach(() => {
      prisma.profile.findFirst = jest.fn().mockResolvedValue(worker());
      prisma.log = { count: jest.fn().mockResolvedValue(0) };
      prisma.agentLead.count = jest.fn().mockResolvedValue(0);
      prisma.agentLead.findUniqueOrThrow = jest
        .fn()
        .mockResolvedValue({ id: 'lead-1' });
    });

    it('matches the number however it was typed', async () => {
      await service.lookupWorker('agent-1', 'job-1', '00242 06 123 45 67');
      expect(prisma.profile.findFirst.mock.calls[0][0].where.phone).toEqual({
        in: ['+242061234567', '242061234567'],
      });
    });

    it('only ever matches a worker: an employer number reads as unknown', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);
      await expect(
        service.lookupWorker('agent-1', 'job-1', '+242069917686'),
      ).rejects.toThrow('Aucun travailleur');
      expect(prisma.profile.findFirst.mock.calls[0][0].where.profile_type).toBe(
        'WORKER',
      );
    });

    it('shows a first name and initial only, and logs the lookup', async () => {
      const result = await service.lookupWorker(
        'agent-1',
        'job-1',
        '+242061234567',
      );
      expect(result.worker).toEqual({
        id: 'worker-9',
        firstName: 'Awa',
        lastInitial: 'M',
        avatarUrl: null,
        city: 'Brazzaville',
      });
      expect(result.blocker).toBeNull();
      expect(logService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AGENT_WORKER_LOOKUP' }),
      );
    });

    it('caps lookups per day', async () => {
      prisma.log.count.mockResolvedValue(2);
      await expect(
        service.lookupWorker('agent-1', 'job-1', '+242061234567'),
      ).rejects.toThrow('Limite atteinte');
      expect(prisma.profile.findFirst).not.toHaveBeenCalled();
    });

    it('answers not found for an unknown number', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);
      await expect(
        service.lookupWorker('agent-1', 'job-1', '+242061234567'),
      ).rejects.toThrow('Aucun travailleur');
    });

    it('rejects a job outside the zones', async () => {
      prisma.jobOffer.count.mockResolvedValue(0);
      await expect(
        service.lookupWorker('agent-1', 'job-1', '+242061234567'),
      ).rejects.toThrow('Offre introuvable');
    });

    it.each([
      [{ status: 'SUSPENDED' }, 'pas actif'],
      [{ verification_status: 'PENDING' }, 'pas encore vérifiée'],
    ])('names the blocker for %o', async (over, text) => {
      prisma.profile.findFirst.mockResolvedValue(worker(over));
      const result = await service.lookupWorker(
        'agent-1',
        'job-1',
        '+242061234567',
      );
      expect(result.blocker).toContain(text);
    });

    it('places them: takes the lead, records the « Intéressé » call, applies', async () => {
      const result = await service.placeByPhone(
        'agent-1',
        'job-1',
        '+242061234567',
      );
      const take = prisma.agentLead.updateMany.mock.calls[0][0];
      expect(take.where).toMatchObject({
        job_offer_id: 'job-1',
        worker_id: 'worker-9',
      });
      expect(take.data).toMatchObject({
        status: 'CLAIMED',
        claimed_by_agent_id: 'agent-1',
      });
      expect(prisma.agentCallLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          lead_id: 'lead-1',
          outcome: 'INTERESTED',
        }),
      });
      expect(applications.create).toHaveBeenCalled();
      expect(result.applicationId).toBe('app-1');
      expect(logService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AGENT_PLACED',
          metadata: expect.objectContaining({ offList: true }),
        }),
      );
    });

    it('refuses a worker another agent holds on this job', async () => {
      prisma.agentLead.count.mockResolvedValue(1);
      await expect(
        service.placeByPhone('agent-1', 'job-1', '+242061234567'),
      ).rejects.toThrow('un autre agent');
      expect(prisma.agentLead.updateMany).not.toHaveBeenCalled();
    });

    it('refuses when another agent wins the race to the lead', async () => {
      prisma.agentLead.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.placeByPhone('agent-1', 'job-1', '+242061234567'),
      ).rejects.toThrow('un autre agent');
      expect(applications.create).not.toHaveBeenCalled();
    });

    it('refuses a worker who already applied', async () => {
      prisma.application.count.mockResolvedValue(1);
      await expect(
        service.placeByPhone('agent-1', 'job-1', '+242061234567'),
      ).rejects.toThrow('déjà postulé');
    });

    it('rejects a malformed number', async () => {
      await expect(
        service.placeByPhone('agent-1', 'job-1', 'abc'),
      ).rejects.toThrow('Numéro WhatsApp invalide');
    });
  });

  describe('invite', () => {
    it('returns the WhatsApp preview: template text, the link as a button', async () => {
      const result = await service.invite('agent-1', 'lead-1');
      expect(result.preview.url).toBe(result.inviteUrl);
      expect(result.preview.buttonText).toBe('Voir l’offre');
      expect(result.preview.body).toContain('Offre dont vous avez parlé');
      expect(result.preview.body).not.toContain('http');
    });

    it('issues a link, and no WhatsApp link before the number was revealed', async () => {
      const result = await service.invite('agent-1', 'lead-1');
      expect(result.inviteUrl).toMatch(
        /^https:\/\/rabotka\.work\/invitations\/[A-Za-z0-9_-]{43}$/,
      );
      expect(result.message).toContain(result.inviteUrl);
      expect(result.whatsappUrl).toBeNull();

      const { data } = prisma.agentLead.updateMany.mock.calls[0][0];
      expect(data.status).toBe(AgentLeadStatus.INVITED);
      expect(result.inviteUrl.endsWith(data.invite_token)).toBe(true);
      expect(data.invite_expires_at.getTime() - data.invited_at.getTime()).toBe(
        48 * HOUR,
      );
      expect(logService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AGENT_INVITE_SENT',
          profileId: 'w1',
        }),
      );
    });

    it('adds a pre-filled WhatsApp link once the agent revealed the number', async () => {
      prisma.agentPhoneReveal.count.mockResolvedValue(1);
      const result = await service.invite('agent-1', 'lead-1');
      expect(result.whatsappUrl).toMatch(
        /^https:\/\/wa\.me\/242061234567\?text=/,
      );
    });

    it('refuses a worker who already applied', async () => {
      prisma.application.count.mockResolvedValue(1);
      await expect(service.invite('agent-1', 'lead-1')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.agentLead.updateMany).not.toHaveBeenCalled();
    });

    it('is for the claimer only', async () => {
      onLoad({ claimed_by_agent_id: 'agent-2' });
      await expect(service.invite('agent-1', 'lead-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
