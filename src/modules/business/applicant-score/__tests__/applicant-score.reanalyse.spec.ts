import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApplicationStatus, CvChoice } from '@prisma/client';
import { ApplicantScoreService } from '../applicant-score.service';

function setup(
  opts: {
    app?: Partial<{
      status: ApplicationStatus;
      profile_cv_id: string | null;
      cv_resume_id: string | null;
    }> | null;
    preferred?: CvChoice;
    live?: string | null;
  } = {},
) {
  const app =
    opts.app === null
      ? null
      : {
          worker_id: 'w1',
          status: ApplicationStatus.PENDING,
          profile_cv_id: null,
          cv_resume_id: null,
          ...opts.app,
        };
  const prisma: any = {
    application: {
      findFirst: jest.fn().mockResolvedValue(app),
      update: jest.fn().mockResolvedValue({}),
    },
    profile: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          preferred_cv: opts.preferred ?? CvChoice.UPLOADED,
        }),
    },
    profileCv: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.live === null ? null : { id: opts.live ?? 'cv-new' },
        ),
    },
    applicationAssessment: { deleteMany: jest.fn().mockResolvedValue({}) },
  };
  const subscriptions: any = { businessOf: jest.fn().mockResolvedValue('b1') };
  const service = new ApplicantScoreService(
    prisma,
    {} as never,
    subscriptions,
    {} as never,
    {} as never,
    {} as never,
  );
  const assess = jest.spyOn(service, 'assess').mockResolvedValue(true);
  const analyse = jest
    .spyOn(service, 'analyse')
    .mockResolvedValue({ screeningId: 's1', analysed: 1, left: 0 });
  return { service, prisma, assess, analyse };
}

describe('ApplicantScoreService.reanalyse', () => {
  it('attaches the CV added since applying and scores again', async () => {
    const { service, prisma, assess, analyse } = setup();

    const out = await service.reanalyse('p1', 'o1', 'a1');

    expect(prisma.application.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { profile_cv_id: 'cv-new' },
    });
    expect(prisma.applicationAssessment.deleteMany).toHaveBeenCalledWith({
      where: { application_id: 'a1' },
    });
    expect(assess).toHaveBeenCalledWith('a1');
    // No CV analysis before: none charged now.
    expect(analyse).not.toHaveBeenCalled();
    expect(out).toEqual({ cv: true, analysis: 'none' });
  });

  it('runs the CV analysis again when the application had one', async () => {
    const { service, analyse } = setup({ app: { cv_resume_id: 'r-old' } });

    const out = await service.reanalyse('p1', 'o1', 'a1');

    expect(analyse).toHaveBeenCalledWith(
      'p1',
      'o1',
      'a1',
      undefined,
      undefined,
      true,
    );
    expect(out.analysis).toBe('started');
  });

  it('still rescores when no « CV inclus » is left for the analysis', async () => {
    const { service, analyse, assess } = setup({
      app: { cv_resume_id: 'r-old' },
    });
    analyse.mockRejectedValue(new ForbiddenException('plus de CV inclus'));

    const out = await service.reanalyse('p1', 'o1', 'a1');

    expect(assess).toHaveBeenCalled();
    expect(out.analysis).toBe('no-room');
  });

  it('refuses when there is no newer CV to read', async () => {
    const same = setup({ app: { profile_cv_id: 'cv-new' } });
    await expect(same.service.reanalyse('p1', 'o1', 'a1')).rejects.toThrow(
      BadRequestException,
    );
    expect(same.prisma.application.update).not.toHaveBeenCalled();

    const none = setup({ live: null });
    await expect(none.service.reanalyse('p1', 'o1', 'a1')).rejects.toThrow(
      'nouveau CV',
    );
  });

  it('never sends a CV the candidate chose not to send', async () => {
    const { service, prisma } = setup({ preferred: CvChoice.RABOTKA });
    await expect(service.reanalyse('p1', 'o1', 'a1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.application.update).not.toHaveBeenCalled();
  });

  it('refuses a closed application, and another business’s', async () => {
    const closed = setup({ app: { status: ApplicationStatus.REJECTED } });
    await expect(closed.service.reanalyse('p1', 'o1', 'a1')).rejects.toThrow(
      'plus en cours',
    );

    const notMine = setup({ app: null });
    await expect(notMine.service.reanalyse('p1', 'o1', 'a1')).rejects.toThrow(
      'introuvable',
    );
    expect(notMine.prisma.application.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          job_offer: { employer_id: 'p1', deleted_at: null },
        }),
      }),
    );
  });
});
