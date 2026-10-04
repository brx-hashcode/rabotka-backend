import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { AgentCallOutcome, AgentLeadStatus } from '@prisma/client';
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
      agentCallLog: { create: jest.fn().mockReturnValue('call-op') },
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
    service = new AgentLeadService(
      prisma,
      systemConfig as any,
      config as any,
      logService as any,
      dispatcher as any,
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

  describe('invite', () => {
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
