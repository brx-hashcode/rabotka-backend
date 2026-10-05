import { NotFoundException } from '@nestjs/common';
import {
  AccountStatus,
  AgentLeadStatus,
  ApplicationStatus,
  JobOfferStatus,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';
import { AgentPortalService } from '../agent-portal.service';
import { jobsInZonesWhere, publicJobsWhere } from '../agent-zones';

const ZONE = { country_code: 'CG', city: 'Brazzaville' };

const JOB_ROW = {
  id: 'job-1',
  reference: 'RBK-1',
  title: 'Plombier',
  description: 'Réparer une fuite',
  employment_type: 'MISSION',
  scheduled_at: null,
  amount: { toString: () => '15000' },
  payment_flow: 'DAILY',
  address: 'Moungali',
  is_remote: false,
  country_code: 'CG',
  country_name: 'Congo',
  city: 'Brazzaville',
  quantity: 3,
  status: JobOfferStatus.ACTIVE,
  created_at: new Date(),
  category: { id: 'c1', name: 'Plomberie', slug: 'plomberie' },
};

function worker(id: string) {
  return {
    id,
    first_name: id,
    last_name: 'X',
    avatar_url: null,
    description: '',
    city: 'Brazzaville',
    reliability_score: 100,
    rating_avg: null,
    rating_count: 0,
    verification_status: VerificationStatus.VERIFIED,
    categories: [{ category: { name: 'Plomberie' } }],
  };
}

describe('jobsInZonesWhere', () => {
  it('matches the offer city, or the employer city when the offer has none', () => {
    const where = jobsInZonesWhere([ZONE]);
    expect(where).toMatchObject({
      deleted_at: null,
      status: {
        in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
      },
    });
    expect(where.OR).toEqual([
      {
        country_code: 'CG',
        city: { equals: 'Brazzaville', mode: 'insensitive' },
      },
      {
        city: null,
        employer: {
          country_code: 'CG',
          city: { equals: 'Brazzaville', mode: 'insensitive' },
        },
      },
    ]);
  });
});

describe('publicJobsWhere', () => {
  it('falls back to the employer city, scoped to the country when given', () => {
    const where = publicJobsWhere({ country: 'cg', city: 'Brazzaville' });
    const city = { equals: 'Brazzaville', mode: 'insensitive' };
    expect(where.AND).toEqual([
      {
        OR: [
          { country_code: 'CG', city },
          { city: null, employer: { country_code: 'CG', city } },
        ],
      },
    ]);
  });

  it('filters by country alone, falling back to the employer country', () => {
    expect(publicJobsWhere({ country: 'CG' }).AND).toEqual([
      {
        OR: [
          { country_code: 'CG' },
          { country_code: null, employer: { country_code: 'CG' } },
        ],
      },
    ]);
  });

  it('searches title or reference', () => {
    expect(publicJobsWhere({ q: 'plomb' }).AND).toEqual([
      {
        OR: [
          { title: { contains: 'plomb', mode: 'insensitive' } },
          { reference: { contains: 'plomb', mode: 'insensitive' } },
        ],
      },
    ]);
  });
});

describe('AgentPortalService', () => {
  let prisma: any;
  let rollout: { versionFor: jest.Mock };
  let matching: { findMatchingWorkersForJob: jest.Mock };
  let engine: { recommendWorkersForJobOffer: jest.Mock };
  let leads: { ensureLeads: jest.Mock };
  let service: AgentPortalService;

  beforeEach(() => {
    prisma = {
      agentZone: { findMany: jest.fn().mockResolvedValue([ZONE]) },
      jobOffer: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([JOB_ROW]),
        findFirst: jest.fn().mockResolvedValue(JOB_ROW),
      },
      application: {
        groupBy: jest
          .fn()
          .mockResolvedValue([{ job_offer_id: 'job-1', _count: { _all: 1 } }]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      profile: { findMany: jest.fn().mockResolvedValue([]) },
      agentLead: { findMany: jest.fn().mockResolvedValue([]) },
    };
    rollout = { versionFor: jest.fn().mockResolvedValue('legacy') };
    matching = { findMatchingWorkersForJob: jest.fn().mockResolvedValue([]) };
    engine = { recommendWorkersForJobOffer: jest.fn() };
    const systemConfig = {
      getAgentCandidateMinScore: jest.fn().mockResolvedValue(0.3),
    };
    leads = {
      ensureLeads: jest.fn(
        (_agent: string, _job: string, ids: string[]) =>
          new Map(ids.map((id) => [id, { id: `lead-${id}` }])),
      ),
    };
    service = new AgentPortalService(
      prisma,
      systemConfig as any,
      matching as any,
      engine as any,
      rollout as any,
      leads as any,
    );
  });

  describe('listJobs', () => {
    it('returns nothing, without querying offers, for an agent with no zone', async () => {
      prisma.agentZone.findMany.mockResolvedValue([]);
      const result = await service.listJobs('agent-1', { page: 1, limit: 20 });
      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
      expect(prisma.jobOffer.findMany).not.toHaveBeenCalled();
    });

    it('confines the query to the agent zones and reports seats left', async () => {
      const result = await service.listJobs('agent-1', { page: 1, limit: 20 });

      const where = prisma.jobOffer.findMany.mock.calls[0][0].where;
      expect(where.AND[0]).toEqual(jobsInZonesWhere([ZONE]));
      expect(result.data[0]).toMatchObject({
        id: 'job-1',
        amount: 15000,
        seatsLeft: 2,
      });
      // The privacy rule, end to end: no employer in what an agent receives.
      expect(Object.keys(result.data[0])).not.toContain('employer');
    });
  });

  describe('listPublicJobs', () => {
    it('serves the summary only: no pay, address, description or employer', async () => {
      const result = await service.listPublicJobs({ page: 1, limit: 20 });

      const select = prisma.jobOffer.findMany.mock.calls[0][0].select;
      for (const field of [
        'amount',
        'payment_flow',
        'address',
        'description',
        'employer',
        'employer_id',
      ]) {
        expect(select).not.toHaveProperty(field);
      }
      expect(result.data[0]).toMatchObject({ id: 'job-1', seatsLeft: 2 });
      expect(Object.keys(result.data[0])).toEqual(
        expect.not.arrayContaining(['amount', 'address', 'description']),
      );
      expect(prisma.agentZone.findMany).not.toHaveBeenCalled();
    });

    it('lists every open job when no filter is given', async () => {
      await service.listPublicJobs({ page: 2, limit: 10 });
      const args = prisma.jobOffer.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        deleted_at: null,
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
      });
      expect(args).toMatchObject({ skip: 10, take: 10 });
    });
  });

  describe('getJob', () => {
    it('answers 404 for a job outside the agent zones', async () => {
      prisma.jobOffer.findFirst.mockResolvedValue(null);
      await expect(service.getJob('agent-1', 'job-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.jobOffer.findFirst.mock.calls[0][0].where).toEqual({
        AND: [{ id: 'job-x' }, jobsInZonesWhere([ZONE])],
      });
    });

    it('answers 404 to an agent with no zone at all', async () => {
      prisma.agentZone.findMany.mockResolvedValue([]);
      await expect(service.getJob('agent-1', 'job-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.jobOffer.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getCandidates', () => {
    beforeEach(() => {
      prisma.jobOffer.findFirst.mockResolvedValue({
        id: 'job-1',
        employer_id: 'emp-1',
      });
    });

    it('keeps rank order, and drops non-placeable and already-applied workers', async () => {
      matching.findMatchingWorkersForJob.mockResolvedValue([
        { id: 'w1', score: 0.9 },
        { id: 'w2', score: 0.8 }, // already applied
        { id: 'w3', score: 0.7 }, // not returned by the eligibility query
        { id: 'w4', score: 0.6 },
        { id: 'w5', score: 0.1 }, // under the threshold
      ]);
      prisma.profile.findMany.mockResolvedValue([
        worker('w4'),
        worker('w1'),
        worker('w2'),
      ]);
      prisma.application.findMany.mockResolvedValue([{ worker_id: 'w2' }]);

      const result = await service.getCandidates('agent-1', 'job-1', 10);

      expect(result.map((c) => c.id)).toEqual(['w1', 'w4']);
      expect(result[0].score).toBe(0.9);

      // Only people ApplicationService.create would accept.
      expect(prisma.profile.findMany.mock.calls[0][0].where).toMatchObject({
        profile_type: ProfileType.WORKER,
        status: AccountStatus.ACTIVE,
        verification_status: VerificationStatus.VERIFIED,
        deleted_at: null,
      });
      expect(prisma.application.findMany.mock.calls[0][0].where).toMatchObject({
        job_offer_id: 'job-1',
        status: { not: ApplicationStatus.CANCELLED },
      });
    });

    it('drops workers an agent already closed, and attaches a lead to each one shown', async () => {
      matching.findMatchingWorkersForJob.mockResolvedValue([
        { id: 'w1', score: 0.9 },
        { id: 'w2', score: 0.8 }, // declined earlier
      ]);
      prisma.profile.findMany.mockResolvedValue([worker('w1'), worker('w2')]);
      prisma.agentLead.findMany.mockResolvedValue([{ worker_id: 'w2' }]);

      const result = await service.getCandidates('agent-1', 'job-1', 10);

      expect(result.map((c) => c.id)).toEqual(['w1']);
      expect(result[0].lead).toEqual({ id: 'lead-w1' });
      expect(leads.ensureLeads).toHaveBeenCalledWith('agent-1', 'job-1', [
        'w1',
      ]);
      expect(prisma.agentLead.findMany.mock.calls[0][0].where.status).toEqual({
        in: [AgentLeadStatus.DECLINED, AgentLeadStatus.UNREACHABLE],
      });
    });

    it('ranks with the employer bucket, requiring verified workers on v2', async () => {
      rollout.versionFor.mockResolvedValue('v2');
      engine.recommendWorkersForJobOffer.mockResolvedValue([]);

      await service.getCandidates('agent-1', 'job-1', 10);

      expect(rollout.versionFor).toHaveBeenCalledWith('emp-1');
      expect(engine.recommendWorkersForJobOffer).toHaveBeenCalledWith(
        'job-1',
        20,
        expect.objectContaining({ requireVerified: true, minScore: 0.3 }),
      );
    });

    it('answers 404 before ranking a job outside the zones', async () => {
      prisma.jobOffer.findFirst.mockResolvedValue(null);
      await expect(
        service.getCandidates('agent-1', 'job-x', 10),
      ).rejects.toThrow(NotFoundException);
      expect(rollout.versionFor).not.toHaveBeenCalled();
    });

    it('never returns a contact field', async () => {
      matching.findMatchingWorkersForJob.mockResolvedValue([
        { id: 'w1', score: 0.9 },
      ]);
      prisma.profile.findMany.mockResolvedValue([worker('w1')]);

      const [candidate] = await service.getCandidates('agent-1', 'job-1', 10);
      for (const field of ['phone', 'directPhone', 'email', 'address']) {
        expect(candidate).not.toHaveProperty(field);
      }
    });
  });
});
