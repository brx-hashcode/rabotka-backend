import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BusinessResumeController } from '../business-resume.controller';

const BIZ = 'biz-profile';
const WORKER = 'worker-1';

type Setup = {
  worker?: { id: string } | null;
  applied?: number;
  worked?: number;
  preselection?: boolean;
};

function setup({
  worker = { id: WORKER },
  applied = 0,
  worked = 0,
  preselection = true,
}: Setup = {}) {
  const resume = {
    download: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('%PDF'), filename: 'CV.pdf' }),
  };
  const prisma = {
    profile: { findFirst: jest.fn().mockResolvedValue(worker) },
    application: { count: jest.fn().mockResolvedValue(applied) },
    assignment: { count: jest.fn().mockResolvedValue(worked) },
  };
  const subscriptions = {
    assertFeature: jest.fn(() =>
      preselection
        ? Promise.resolve()
        : Promise.reject(
            new ForbiddenException(
              'Votre formule ne comprend pas la présélection.',
            ),
          ),
    ),
  };
  const res = { setHeader: jest.fn(), send: jest.fn() };
  const ctrl = new BusinessResumeController(
    resume as any,
    prisma as any,
    subscriptions as any,
  );
  const call = () =>
    ctrl.view({ user: { profileId: BIZ } } as any, WORKER, res as any);
  return { resume, prisma, subscriptions, res, call };
}

describe('BusinessResumeController', () => {
  it('serves an applicant the CV without contacts, whatever the plan', async () => {
    const t = setup({ applied: 1, preselection: false });
    await t.call();
    expect(t.resume.download).toHaveBeenCalledWith(WORKER, {
      withContacts: false,
    });
    expect(t.subscriptions.assertFeature).not.toHaveBeenCalled();
    expect(t.res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(t.res.send).toHaveBeenCalled();
  });

  it('scopes the applications and missions to the business’s own offers', async () => {
    const t = setup({ worked: 1 });
    await t.call();
    const where = { worker_id: WORKER, job_offer: { employer_id: BIZ } };
    expect(t.prisma.application.count).toHaveBeenCalledWith({ where });
    expect(t.prisma.assignment.count).toHaveBeenCalledWith({ where });
  });

  it('serves any worker when the plan includes the preselection', async () => {
    const t = setup();
    await t.call();
    expect(t.subscriptions.assertFeature).toHaveBeenCalledWith(
      BIZ,
      'preselection',
    );
    expect(t.res.send).toHaveBeenCalled();
  });

  it('refuses a stranger without the preselection', async () => {
    const t = setup({ preselection: false });
    await expect(t.call()).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.resume.download).not.toHaveBeenCalled();
  });

  it('404s on anything but a live worker', async () => {
    const t = setup({ worker: null });
    await expect(t.call()).rejects.toBeInstanceOf(NotFoundException);
    expect(t.resume.download).not.toHaveBeenCalled();
  });
});
