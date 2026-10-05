import { NotFoundException } from '@nestjs/common';
import {
  AccountStatus,
  AgentLeadStatus,
  ApplicationStatus,
  EmploymentType,
  JobOfferStatus,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';
import { AgentPortalService } from '../agent-portal.service';
import {
  jobFiltersWhere,
  jobsInZonesWhere,
  publicScopeWhere,
  withFilters,
} from '../agent-zones';
import {
  parseAmount,
  parseCategorySlugs,
  parseEmploymentTypes,
  parseSort,
} from '../job-list-query';

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

describe('publicScopeWhere', () => {
  it('falls back to the employer city, scoped to the country when given', () => {
    const where = publicScopeWhere({ country: 'cg', city: 'Brazzaville' });
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
    expect(publicScopeWhere({ country: 'CG' }).AND).toEqual([
      {
        OR: [
          { country_code: 'CG' },
          { country_code: null, employer: { country_code: 'CG' } },
        ],
      },
    ]);
  });
});

describe('jobFiltersWhere', () => {
  it('builds one clause per active filter', () => {
    expect(
      jobFiltersWhere({
        q: 'plomb',
        employmentTypes: [EmploymentType.CDD],
        categories: ['plomberie'],
        minAmount: 5000,
      }),
    ).toEqual([
      {
        OR: [
          { title: { contains: 'plomb', mode: 'insensitive' } },
          { reference: { contains: 'plomb', mode: 'insensitive' } },
        ],
      },
      { employment_type: { in: [EmploymentType.CDD] } },
      { category: { slug: { in: ['plomberie'] } } },
      { amount: { gte: 5000 } },
    ]);
  });

  it('is empty without filters, so the scope stays the whole where', () => {
    expect(jobFiltersWhere({ employmentTypes: [], categories: [] })).toEqual(
      [],
    );
    const scope = { deleted_at: null };
    expect(withFilters(scope, {})).toBe(scope);
  });
});

describe('job list query parsing', () => {
  it('keeps known employment types and drops the rest', () => {
    expect(parseEmploymentTypes('cdd, MISSION,bogus')).toEqual([
      EmploymentType.CDD,
      EmploymentType.MISSION,
    ]);
    expect(parseEmploymentTypes('bogus')).toBeUndefined();
  });

  it('accepts slug-shaped categories only', () => {
    expect(parseCategorySlugs('plomberie,Menuiserie,<script>')).toEqual([
      'plomberie',
      'menuiserie',
    ]);
  });

  it('reads amounts and sort leniently', () => {
    expect(parseAmount('15000.7')).toBe(15000);
    expect(parseAmount('-1')).toBeUndefined();
    expect(parseAmount('abc')).toBeUndefined();
    expect(parseSort('start')).toBe('start');
    expect(parseSort('anything')).toBe('recent');
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
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({
          _min: { amount: null },
          _max: { amount: null },
        }),
      },
      jobCategory: { findMany: jest.fn().mockResolvedValue([]) },
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
      expect(result).toEqual({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        facets: { employmentType: {}, category: {}, amount: null },
      });
      expect(prisma.jobOffer.findMany).not.toHaveBeenCalled();
    });

    it('confines the query to the agent zones and reports seats left', async () => {
      const result = await service.listJobs('agent-1', { page: 1, limit: 20 });

      const where = prisma.jobOffer.findMany.mock.calls[0][0].where;
      expect(where).toEqual(jobsInZonesWhere([ZONE]));
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

    it('never filters or reports on pay', async () => {
      const result = await service.listPublicJobs({
        page: 1,
        limit: 20,
        minAmount: 1000,
      } as never);
      const where = prisma.jobOffer.findMany.mock.calls[0][0].where;
      expect(JSON.stringify(where)).not.toContain('amount');
      expect(prisma.jobOffer.aggregate).not.toHaveBeenCalled();
      expect(result.facets).not.toHaveProperty('amount');
    });

    it('counts each facet without its own filter, keyed by slug', async () => {
      prisma.jobOffer.groupBy.mockImplementation(({ by }: { by: string[] }) =>
        Promise.resolve(
          by[0] === 'employment_type'
            ? [{ employment_type: 'CDD', _count: { _all: 4 } }]
            : [
                { category_id: 'c1', _count: { _all: 3 } },
                { category_id: null, _count: { _all: 9 } },
              ],
        ),
      );
      prisma.jobCategory.findMany.mockResolvedValue([
        { id: 'c1', slug: 'plomberie' },
      ]);

      const result = await service.listPublicJobs({
        page: 1,
        limit: 20,
        employmentTypes: [EmploymentType.CDD],
        categories: ['plomberie'],
      });

      const [typeCall, categoryCall] = prisma.jobOffer.groupBy.mock.calls.map(
        (c: [{ where: unknown }]) => JSON.stringify(c[0].where),
      );
      expect(typeCall).not.toContain('employment_type');
      expect(typeCall).toContain('plomberie');
      expect(categoryCall).toContain('CDD');
      expect(categoryCall).not.toContain('plomberie');
      expect(result.facets).toEqual({
        employmentType: { CDD: 4 },
        category: { plomberie: 3 },
      });
    });
  });

  describe('getPublicJob', () => {
    it('returns the public summary of an open job', async () => {
      const job = await service.getPublicJob('job-1');
      const args = prisma.jobOffer.findFirst.mock.calls[0][0];
      expect(args.where.AND[1]).toEqual({ id: 'job-1' });
      expect(args.where.AND[0]).toMatchObject({ deleted_at: null });
      expect(args.select).not.toHaveProperty('amount');
      expect(job).toMatchObject({ id: 'job-1', seatsLeft: 2 });
      expect(job).not.toHaveProperty('address');
    });

    it('answers 404 for a closed or unknown job', async () => {
      prisma.jobOffer.findFirst.mockResolvedValue(null);
      await expect(service.getPublicJob('job-x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listJobs facets', () => {
    it('reports the pay range of the zone jobs, ignoring the pay filter', async () => {
      prisma.jobOffer.aggregate.mockResolvedValue({
        _min: { amount: { toString: () => '5000' } },
        _max: { amount: { toString: () => '20000' } },
      });
      const result = await service.listJobs('agent-1', {
        page: 1,
        limit: 20,
        minAmount: 8000,
      });

      const aggregateWhere = JSON.stringify(
        prisma.jobOffer.aggregate.mock.calls[0][0].where,
      );
      expect(aggregateWhere).not.toContain('8000');
      expect(
        JSON.stringify(prisma.jobOffer.findMany.mock.calls[0][0].where),
      ).toContain('8000');
      expect(result.facets.amount).toEqual({ min: 5000, max: 20000 });
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
