import { ForbiddenException } from '@nestjs/common';
import { ProfileType } from '@prisma/client';
import { MobileFeedController } from '../mobile-feed.controller';

type Req = { user: { profileId: string } };
const reqFor = (profileId: string): Req => ({ user: { profileId } });

describe('MobileFeedController', () => {
  let controller: MobileFeedController;
  let prisma: { profile: { findUnique: jest.Mock } };
  let jobOfferService: { findById: jest.Mock; findByEmployerId: jest.Mock };
  let applicationService: { findByEmployer: jest.Mock };
  let matchingService: { findMatchingJobsForWorker: jest.Mock };

  const mockType = (type: ProfileType | null) =>
    prisma.profile.findUnique.mockResolvedValue(
      type ? { profile_type: type } : null,
    );

  beforeEach(() => {
    prisma = { profile: { findUnique: jest.fn() } };
    jobOfferService = { findById: jest.fn(), findByEmployerId: jest.fn() };
    applicationService = { findByEmployer: jest.fn() };
    matchingService = { findMatchingJobsForWorker: jest.fn() };

    controller = new MobileFeedController(
      prisma as never,
      jobOfferService as never,
      applicationService as never,
      matchingService as never,
    );
  });

  describe('job-feed (WORKER)', () => {
    it('hydrates matched ids into offers with matchScore', async () => {
      mockType(ProfileType.WORKER);
      matchingService.findMatchingJobsForWorker.mockResolvedValue([
        { id: 'job-1', score: 0.9 },
        { id: 'job-2', score: 0.7 },
      ]);
      jobOfferService.findById
        .mockResolvedValueOnce({ id: 'job-1', title: 'A' })
        .mockResolvedValueOnce({ id: 'job-2', title: 'B' });

      const result = await controller.jobFeed(reqFor('w1') as never, '10');

      expect(matchingService.findMatchingJobsForWorker).toHaveBeenCalledWith('w1', 10);
      expect(result).toEqual([
        { id: 'job-1', title: 'A', matchScore: 0.9 },
        { id: 'job-2', title: 'B', matchScore: 0.7 },
      ]);
    });

    it('drops ids that no longer resolve to an offer', async () => {
      mockType(ProfileType.WORKER);
      matchingService.findMatchingJobsForWorker.mockResolvedValue([
        { id: 'job-1', score: 0.9 },
        { id: 'gone', score: 0.5 },
      ]);
      jobOfferService.findById
        .mockResolvedValueOnce({ id: 'job-1', title: 'A' })
        .mockResolvedValueOnce(null);

      const result = await controller.jobFeed(reqFor('w1') as never, undefined);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('job-1');
    });

    it('403s for an EMPLOYER', async () => {
      mockType(ProfileType.EMPLOYER);
      await expect(controller.jobFeed(reqFor('e1') as never)).rejects.toThrow(
        ForbiddenException,
      );
      expect(matchingService.findMatchingJobsForWorker).not.toHaveBeenCalled();
    });
  });

  describe('job-offers (EMPLOYER)', () => {
    it('returns the employer’s offers', async () => {
      mockType(ProfileType.EMPLOYER);
      jobOfferService.findByEmployerId.mockResolvedValue({ items: [{ id: 'o1' }], total: 1 });

      const result = await controller.myJobOffers(reqFor('e1') as never);

      expect(jobOfferService.findByEmployerId).toHaveBeenCalledWith('e1', {
        page: 0,
        pageSize: 20,
      });
      expect(result).toEqual({ items: [{ id: 'o1' }], total: 1 });
    });

    it('403s for a WORKER', async () => {
      mockType(ProfileType.WORKER);
      await expect(controller.myJobOffers(reqFor('w1') as never)).rejects.toThrow(
        ForbiddenException,
      );
      expect(jobOfferService.findByEmployerId).not.toHaveBeenCalled();
    });
  });

  describe('received-applications (EMPLOYER)', () => {
    it('returns applications received', async () => {
      mockType(ProfileType.EMPLOYER);
      applicationService.findByEmployer.mockResolvedValue({ items: [{ id: 'a1' }], total: 1 });

      const result = await controller.receivedApplications(reqFor('e1') as never);

      expect(applicationService.findByEmployer).toHaveBeenCalledWith('e1', {
        page: 0,
        pageSize: 20,
      });
      expect(result).toEqual({ items: [{ id: 'a1' }], total: 1 });
    });

    it('403s for a WORKER', async () => {
      mockType(ProfileType.WORKER);
      await expect(
        controller.receivedApplications(reqFor('w1') as never),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
