import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { TeamActor } from '../../team/team.service';
import { CandidateNotesService } from '../candidate-notes.service';

const actor = (memberId = 'me'): TeamActor =>
  ({
    businessId: 'b-1',
    profileId: 'p-1',
    member: { id: memberId, name: 'Awa', role: 'RECRUITER' },
  }) as unknown as TeamActor;

describe('CandidateNotesService', () => {
  let prisma: any;
  let service: CandidateNotesService;

  beforeEach(() => {
    prisma = {
      application: {
        findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }),
        findUniqueOrThrow: jest.fn(),
      },
      externalApplication: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'ext-1', cv_resume_id: 'cv-1' }),
        findUniqueOrThrow: jest.fn(),
      },
      candidateNote: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      candidateOpinion: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      interview: { findMany: jest.fn().mockResolvedValue([]) },
      businessActivity: { findMany: jest.fn().mockResolvedValue([]) },
      jobOffer: { findFirst: jest.fn() },
    };
    service = new CandidateNotesService(prisma);
  });

  it("only opens an application on one of the business's own offers", async () => {
    await service.notes(actor(), 'rabotka', 'app-1');
    expect(prisma.application.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ job_offer: { employer_id: 'p-1' } }),
      }),
    );
    prisma.externalApplication.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.notes(actor(), 'external', 'other'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes a note as the member, on the right application', async () => {
    await service.addNote(actor(), 'external', 'ext-1', '  Très bon profil  ');
    expect(prisma.candidateNote.create).toHaveBeenCalledWith({
      data: {
        business_id: 'b-1',
        member_id: 'me',
        body: 'Très bon profil',
        external_application_id: 'ext-1',
      },
    });
    await expect(
      service.addNote(actor(), 'external', 'ext-1', '   '),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets only its author change a note', async () => {
    prisma.candidateNote.findFirst.mockResolvedValue({
      member_id: 'someone-else',
    });
    await expect(
      service.editNote(actor(), 'rabotka', 'app-1', 'n-1', 'x'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.deleteNote(actor(), 'rabotka', 'app-1', 'n-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps one opinion per member, changed in place', async () => {
    await service.setOpinion(actor(), 'rabotka', 'app-1', 'YES');
    expect(prisma.candidateOpinion.create).toHaveBeenCalledWith({
      data: {
        business_id: 'b-1',
        member_id: 'me',
        verdict: 'YES',
        application_id: 'app-1',
      },
    });
    prisma.candidateOpinion.findFirst.mockResolvedValueOnce({ id: 'o-1' });
    await service.setOpinion(actor(), 'rabotka', 'app-1', 'NO');
    expect(prisma.candidateOpinion.update).toHaveBeenCalledWith({
      where: { id: 'o-1' },
      data: { verdict: 'NO' },
    });
  });

  it('sums the opinions, and says which is mine', async () => {
    const at = new Date();
    prisma.candidateOpinion.findMany.mockResolvedValue([
      {
        member_id: 'me',
        verdict: 'YES',
        updated_at: at,
        member: { id: 'me', name: 'Awa', role: 'RECRUITER' },
      },
      {
        member_id: 'x',
        verdict: 'MAYBE',
        updated_at: at,
        member: { id: 'x', name: 'Jean', role: 'ADMIN' },
      },
    ]);
    const r = await service.opinions(actor(), 'rabotka', 'app-1');
    expect(r.mine).toBe('YES');
    expect(r.summary).toEqual({ YES: 1, MAYBE: 1, NO: 0 });
  });

  it('counts opinions per application for an offer’s cards', async () => {
    prisma.jobOffer.findFirst.mockResolvedValue({ id: 'o' });
    prisma.candidateOpinion.findMany.mockResolvedValue([
      { application_id: 'a', external_application_id: null, verdict: 'YES' },
      { application_id: 'a', external_application_id: null, verdict: 'NO' },
      { application_id: null, external_application_id: 'e', verdict: 'MAYBE' },
    ]);
    await expect(service.offerOpinions(actor(), 'o')).resolves.toEqual({
      rabotka: { a: { YES: 1, MAYBE: 0, NO: 1 } },
      external: { e: { YES: 0, MAYBE: 1, NO: 0 } },
    });
  });

  it('tells the story in order, with who decided', async () => {
    prisma.externalApplication.findUniqueOrThrow.mockResolvedValue({
      created_at: new Date('2026-11-01T08:00:00Z'),
      viewed_at: new Date('2026-11-01T09:00:00Z'),
      retained_at: new Date('2026-11-03T10:00:00Z'),
      refused_at: null,
    });
    prisma.interview.findMany.mockResolvedValue([
      {
        created_at: new Date('2026-11-02T10:00:00Z'),
        starts_at: new Date('2026-11-04T10:00:00Z'),
        status: 'CONFIRMED',
      },
    ]);
    prisma.businessActivity.findMany.mockResolvedValue([
      {
        action: 'POST /business/me/external-applications/:id/retain',
        member: { id: 'me', name: 'Awa', role: 'RECRUITER' },
      },
    ]);
    const events = await service.timeline(actor(), 'external', 'ext-1');
    expect(events.map((e) => e.kind)).toEqual([
      'APPLIED',
      'VIEWED',
      'INTERVIEW',
      'RETAINED',
    ]);
    expect(events[3].member?.name).toBe('Awa');
    // An outside candidate's interviews hang on its CV.
    expect(prisma.interview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_id: 'b-1', OR: [{ cv_resume_id: 'cv-1' }] },
      }),
    );
  });
});
