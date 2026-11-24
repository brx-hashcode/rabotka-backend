import { BadRequestException, NotFoundException } from '@nestjs/common';
import { memberMayCall } from '../../team/team-access';
import { CvRemovalService } from '../cv-removal.service';

const FILE = '11111111-1111-4111-8111-111111111111';
const answers = [{ kind: 'FILE', value: `${FILE}:diplome.pdf` }];

const resume = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'SCORED',
  storage_key: 'k/r1',
  storage_bucket: 'b',
  candidate: { name: 'Awa', email: 'a@b.c', phone: '06' },
  ...over,
});

function make(
  found: {
    application?: unknown;
    external?: unknown;
    resume?: unknown;
  } = {},
) {
  const prisma: any = {
    application: {
      findFirst: jest.fn().mockResolvedValue(found.application ?? null),
      update: jest.fn(),
    },
    externalApplication: {
      findFirst: jest.fn().mockResolvedValue(found.external ?? null),
      update: jest.fn(),
    },
    cvScreeningResume: {
      findFirst: jest.fn().mockResolvedValue(found.resume ?? null),
      update: jest.fn(),
    },
    cvResumeMessage: { deleteMany: jest.fn() },
    cvComparisonMessage: { deleteMany: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const storage = { delete: jest.fn().mockResolvedValue(undefined) };
  const answerFiles = { remove: jest.fn() };
  const service = new CvRemovalService(
    prisma,
    storage as never,
    answerFiles as never,
    { businessOf: jest.fn().mockResolvedValue('b1') } as never,
  );
  return { service, prisma, storage, answerFiles };
}

describe('CvRemovalService', () => {
  it('deletes a Rabotka application’s CV, marked before anything goes', async () => {
    const { service, prisma, storage, answerFiles } = make({
      application: {
        id: 'a1',
        cv_removed_at: null,
        answers,
        cv_resume: resume(),
      },
    });
    await service.application('p1', 'a1');
    expect(prisma.application.findFirst.mock.calls[0][0].where).toEqual({
      id: 'a1',
      deleted_at: null,
      job_offer: { employer_id: 'p1' },
    });
    expect(prisma.application.update.mock.calls[0][0].data).toEqual({
      cv_removed_at: expect.any(Date),
    });
    expect(storage.delete).toHaveBeenCalledWith('k/r1', { bucket: 'b' });
    const data = prisma.cvScreeningResume.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      storage_key: null,
      cv_text: null,
      candidate: { name: 'Awa', email: null, phone: null },
      removed_at: expect.any(Date),
    });
    // The score and what the analysis found stay.
    expect(data).not.toHaveProperty('score');
    expect(answerFiles.remove).toHaveBeenCalledWith([FILE], expect.any(Date));
  });

  it('deletes a careers candidate’s original too, or leaves it to the sweep', async () => {
    const external = {
      id: 'x1',
      cv_removed_at: null,
      cv_storage_key: 'k/original',
      cv_storage_bucket: 'b',
      answers,
      cv_resume: null,
    };
    const ok = make({ external });
    await ok.service.external('p1', 'x1');
    expect(ok.prisma.externalApplication.update).toHaveBeenLastCalledWith({
      where: { id: 'x1' },
      data: { cv_storage_key: null, cv_storage_bucket: null },
    });

    const down = make({ external });
    down.storage.delete.mockRejectedValue(new Error('S3 down'));
    jest.spyOn((down.service as any).logger, 'error').mockImplementation();
    await down.service.external('p1', 'x1');
    expect(down.prisma.externalApplication.update).toHaveBeenCalledTimes(1);
    expect(
      down.prisma.externalApplication.update.mock.calls[0][0].data,
    ).toEqual({
      cv_removed_at: expect.any(Date),
      cv_expires_at: expect.any(Date),
    });
  });

  it('goes through the application a CV of an analysis came with', async () => {
    const { service, prisma } = make({
      resume: {
        ...resume(),
        removed_at: null,
        application: { id: 'a1' },
        external_application: null,
      },
      application: {
        id: 'a1',
        cv_removed_at: null,
        answers: [],
        cv_resume: resume(),
      },
    });
    await service.resume('p1', 's1', 'r1');
    expect(prisma.application.update).toHaveBeenCalled();
    expect(prisma.cvScreeningResume.findFirst.mock.calls[0][0].where).toEqual({
      id: 'r1',
      screening: { id: 's1', business_id: 'b1' },
    });
  });

  it('is asked twice without harm, refuses a CV being read, and another business’s', async () => {
    const done = make({
      application: {
        id: 'a1',
        cv_removed_at: new Date(),
        answers,
        cv_resume: resume(),
      },
    });
    await done.service.application('p1', 'a1');
    expect(done.storage.delete).not.toHaveBeenCalled();

    const reading = make({
      application: {
        id: 'a1',
        cv_removed_at: null,
        answers,
        cv_resume: resume({ status: 'QUEUED' }),
      },
    });
    await expect(reading.service.application('p1', 'a1')).rejects.toThrow(
      BadRequestException,
    );
    expect(reading.prisma.application.update).not.toHaveBeenCalled();

    await expect(make().service.application('p2', 'a1')).rejects.toThrow(
      NotFoundException,
    );
    await expect(make().service.external('p2', 'x1')).rejects.toThrow(
      NotFoundException,
    );
    await expect(make().service.resume('p2', 's1', 'r1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('is for recruiters and administrators, not an Évaluateur', () => {
    for (const path of [
      '/business/me/applications/:id/cv',
      '/business/me/external-applications/:id/cv',
      '/business/me/cv-screenings/:id/resumes/:resumeId/file',
    ]) {
      expect(memberMayCall('RECRUITER', 'DELETE', path)).toBe(true);
      expect(memberMayCall('ADMIN', 'DELETE', path)).toBe(true);
      expect(memberMayCall('REVIEWER', 'DELETE', path)).toBe(false);
    }
  });
});
