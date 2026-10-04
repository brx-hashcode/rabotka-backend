import { GoneException, NotFoundException } from '@nestjs/common';
import { AgentLeadStatus } from '@prisma/client';
import { AgentInviteService } from '../agent-invite.service';

const HOUR = 60 * 60 * 1000;

function lead(over: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    status: AgentLeadStatus.INVITED,
    worker_id: 'w1',
    job_offer_id: 'job-1',
    claimed_by_agent_id: 'agent-1',
    invite_expires_at: new Date(Date.now() + HOUR),
    application_id: null,
    claimed_by: { first_name: 'Jean' },
    job_offer: {
      id: 'job-1',
      reference: 'JOB-1',
      title: 'Plombier',
      description: 'Fuite',
      city: 'Brazzaville',
      address: 'Moungali',
      scheduled_at: null,
      amount: 15000,
      employment_type: null,
      category: null,
    },
    ...over,
  };
}

describe('AgentInviteService', () => {
  let prisma: any;
  let applications: { create: jest.Mock };
  let logService: { create: jest.Mock };
  let events: { emit: jest.Mock };
  let service: AgentInviteService;

  beforeEach(() => {
    prisma = {
      agentLead: {
        findUnique: jest.fn().mockResolvedValue(lead()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Sophie', last_name: 'Test' }),
      },
    };
    applications = { create: jest.fn().mockResolvedValue({ id: 'app-1' }) };
    logService = { create: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };
    service = new AgentInviteService(
      prisma,
      applications as any,
      logService as any,
      events as any,
    );
  });

  it('shows the job and the agent first name, without employer data', async () => {
    const result = await service.get('w1', 'tok');
    expect(result).toMatchObject({
      status: AgentLeadStatus.INVITED,
      expired: false,
      agent: { firstName: 'Jean' },
      job: { title: 'Plombier', amount: 15000 },
    });
    expect(result.job).not.toHaveProperty('employer');
  });

  it('answers 404 to anyone but the invited worker', async () => {
    await expect(service.get('w2', 'tok')).rejects.toThrow(NotFoundException);
    await expect(service.accept('w2', 'tok')).rejects.toThrow(
      NotFoundException,
    );
    expect(applications.create).not.toHaveBeenCalled();
  });

  it('applies through ApplicationService with the agent, then confirms the lead', async () => {
    const result = await service.accept('w1', 'tok');
    expect(applications.create).toHaveBeenCalledWith('job-1', 'w1', {
      agentId: 'agent-1',
    });
    expect(prisma.agentLead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', status: AgentLeadStatus.INVITED },
      data: expect.objectContaining({
        status: AgentLeadStatus.CONFIRMED,
        application_id: 'app-1',
      }),
    });
    expect(result).toEqual({ success: true, applicationId: 'app-1' });
    expect(events.emit).toHaveBeenCalledWith(
      'admin.notification.agent.placement',
      expect.objectContaining({
        entityType: 'agent-placement',
        entityId: 'app-1',
        message: 'Jean a placé Sophie Test sur « Plombier »',
      }),
    );
  });

  it('leaves the lead untouched when the application is refused', async () => {
    applications.create.mockRejectedValue(new Error('daily limit'));
    await expect(service.accept('w1', 'tok')).rejects.toThrow('daily limit');
    expect(prisma.agentLead.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses an expired or already answered invitation with 410', async () => {
    prisma.agentLead.findUnique.mockResolvedValue(
      lead({ invite_expires_at: new Date(Date.now() - HOUR) }),
    );
    await expect(service.accept('w1', 'tok')).rejects.toThrow(GoneException);

    prisma.agentLead.findUnique.mockResolvedValue(
      lead({ status: AgentLeadStatus.CONFIRMED }),
    );
    await expect(service.decline('w1', 'tok')).rejects.toThrow(GoneException);
    expect(applications.create).not.toHaveBeenCalled();
  });

  it('declines', async () => {
    await service.decline('w1', 'tok');
    expect(prisma.agentLead.updateMany.mock.calls[0][0].data).toMatchObject({
      status: AgentLeadStatus.DECLINED,
    });
    expect(logService.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AGENT_INVITE_DECLINED' }),
    );
  });
});
