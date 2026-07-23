import { Logger } from '@nestjs/common';
import { ProfileType } from '@prisma/client';
import { PortfolioService } from '../portfolio.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

type AnyMock = jest.Mock;

function makeFile(name = 'work.jpg'): Express.Multer.File {
  return {
    buffer: Buffer.from('x'),
    originalname: name,
    mimetype: 'image/jpeg',
    size: 10,
  } as unknown as Express.Multer.File;
}

describe('PortfolioService', () => {
  let prisma: {
    profile: { findUnique: AnyMock; update: AnyMock };
    portfolioItem: {
      count: AnyMock;
      create: AnyMock;
      findMany: AnyMock;
      findFirst: AnyMock;
      update: AnyMock;
      delete: AnyMock;
      findUniqueOrThrow: AnyMock;
    };
    portfolioImage: {
      count: AnyMock;
      createMany: AnyMock;
      findMany: AnyMock;
      findFirst: AnyMock;
      delete: AnyMock;
    };
    application: { count: AnyMock };
  };
  let fileService: { uploadToStorage: AnyMock };
  let storageService: { delete: AnyMock };
  let matchingService: { indexWorkerProfile: AnyMock };
  let service: PortfolioService;

  beforeEach(() => {
    prisma = {
      profile: { findUnique: jest.fn(), update: jest.fn() },
      portfolioItem: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      portfolioImage: {
        count: jest.fn(),
        createMany: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
      },
      application: { count: jest.fn() },
    };
    fileService = { uploadToStorage: jest.fn() };
    storageService = { delete: jest.fn().mockResolvedValue(undefined) };
    matchingService = {
      indexWorkerProfile: jest.fn().mockResolvedValue(undefined),
    };

    service = new PortfolioService(
      prisma as never,
      fileService as never,
      storageService as never,
      matchingService as never,
    );
  });

  describe('createItem', () => {
    it('uploads all images, creates the item + gallery, ensures slug, re-indexes', async () => {
      prisma.profile.findUnique
        .mockResolvedValueOnce({ id: 'w1', profile_type: ProfileType.WORKER }) // worker check
        .mockResolvedValueOnce({
          portfolio_slug: null,
          first_name: 'Jean',
          last_name: 'Dupont',
        }); // ensureSlug
      prisma.portfolioItem.count.mockResolvedValue(0);
      fileService.uploadToStorage
        .mockResolvedValueOnce({ url: 'u1', key: 'k1' })
        .mockResolvedValueOnce({ url: 'u2', key: 'k2' });
      prisma.portfolioItem.create.mockResolvedValue({
        id: 'item1',
        title: 'Peinture',
        description: 'desc',
        position: 0,
        created_at: new Date(),
        images: [
          { id: 'i1', image_url: 'u1', position: 0 },
          { id: 'i2', image_url: 'u2', position: 1 },
        ],
      });
      prisma.profile.update.mockResolvedValue({
        portfolio_slug: 'jean-dupont-abc123',
      });

      const result = await service.createItem(
        'w1',
        { title: 'Peinture', description: 'desc' },
        [makeFile('a.jpg'), makeFile('b.jpg')],
      );

      expect(fileService.uploadToStorage).toHaveBeenCalledTimes(2);
      const createArg = prisma.portfolioItem.create.mock.calls[0][0];
      expect(createArg.data.profile_id).toBe('w1');
      expect(createArg.data.images.create).toHaveLength(2);
      expect(createArg.data.images.create[0]).toMatchObject({
        image_url: 'u1',
        storage_key: 'k1',
        position: 0,
      });
      expect(prisma.profile.update).toHaveBeenCalled(); // slug ensured
      expect(matchingService.indexWorkerProfile).toHaveBeenCalledWith('w1');
      expect(result.images).toHaveLength(2);
    });

    it('rejects non-worker profiles', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce({
        id: 'e1',
        profile_type: ProfileType.EMPLOYER,
      });
      await expect(
        service.createItem('e1', { title: 't', description: 'd' }, [
          makeFile(),
        ]),
      ).rejects.toThrow('travailleurs');
      expect(fileService.uploadToStorage).not.toHaveBeenCalled();
    });

    it('requires at least one image', async () => {
      await expect(
        service.createItem('w1', { title: 't', description: 'd' }, []),
      ).rejects.toThrow('image');
    });
  });

  describe('ownership', () => {
    it('updateItem throws 404 when the item is not owned by the caller', async () => {
      prisma.portfolioItem.findFirst.mockResolvedValue(null);
      await expect(
        service.updateItem('w1', 'item-x', { title: 'new' }),
      ).rejects.toThrow('non trouvée');
      expect(prisma.portfolioItem.update).not.toHaveBeenCalled();
      // ownership query is scoped to the caller
      expect(prisma.portfolioItem.findFirst).toHaveBeenCalledWith({
        where: { id: 'item-x', profile_id: 'w1' },
        select: { id: true },
      });
    });

    it('updateItem re-indexes when text changes', async () => {
      prisma.portfolioItem.findFirst.mockResolvedValue({ id: 'item1' });
      prisma.portfolioItem.update.mockResolvedValue({
        id: 'item1',
        title: 'new',
        description: 'd',
        position: 0,
        created_at: new Date(),
        images: [],
      });
      await service.updateItem('w1', 'item1', { title: 'new' });
      expect(matchingService.indexWorkerProfile).toHaveBeenCalledWith('w1');
    });
  });

  describe('deleteItem', () => {
    it('deletes stored images then the row and re-indexes', async () => {
      prisma.portfolioItem.findFirst.mockResolvedValue({ id: 'item1' });
      prisma.portfolioImage.findMany.mockResolvedValue([
        { storage_key: 'k1' },
        { storage_key: null },
        { storage_key: 'k2' },
      ]);
      prisma.portfolioItem.delete.mockResolvedValue({});

      await service.deleteItem('w1', 'item1');

      expect(storageService.delete).toHaveBeenCalledTimes(2); // null skipped
      expect(storageService.delete).toHaveBeenCalledWith('k1');
      expect(prisma.portfolioItem.delete).toHaveBeenCalledWith({
        where: { id: 'item1' },
      });
      expect(matchingService.indexWorkerProfile).toHaveBeenCalledWith('w1');
    });
  });

  describe('removeImage', () => {
    it('does NOT re-index (image-only change) and cleans storage', async () => {
      prisma.portfolioItem.findFirst.mockResolvedValue({ id: 'item1' });
      prisma.portfolioImage.findFirst.mockResolvedValue({
        id: 'img1',
        storage_key: 'k9',
      });
      prisma.portfolioImage.delete.mockResolvedValue({});

      await service.removeImage('w1', 'item1', 'img1');

      expect(storageService.delete).toHaveBeenCalledWith('k9');
      expect(prisma.portfolioImage.delete).toHaveBeenCalledWith({
        where: { id: 'img1' },
      });
      expect(matchingService.indexWorkerProfile).not.toHaveBeenCalled();
    });
  });

  describe('getPublicBySlug', () => {
    it('returns a curated view WITHOUT phone/email', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'w1',
        portfolio_slug: 'jean-dupont-abc123',
        first_name: 'Jean',
        last_name: 'Dupont',
        avatar_url: 'http://img/a.png',
        reliability_score: 88,
        rating_avg: 4.5,
        rating_count: 12,
        description: 'Peintre',
        address: 'Bacongo',
        profile_type: ProfileType.WORKER,
        portfolio_items: [
          {
            id: 'item1',
            title: 'Peinture',
            description: 'desc',
            position: 0,
            created_at: new Date(),
            images: [{ id: 'i1', image_url: 'u1', position: 0 }],
          },
        ],
      });
      prisma.application.count.mockResolvedValue(5);

      const view = await service.getPublicBySlug('jean-dupont-abc123');

      expect(view.firstName).toBe('Jean');
      expect(view.completedMissionsCount).toBe(5);
      expect(view.portfolio).toHaveLength(1);
      expect(view.portfolio[0].images[0].imageUrl).toBe('u1');
      // contact fields must never be present in the public payload
      expect(JSON.stringify(view)).not.toContain('phone');
      expect(JSON.stringify(view)).not.toContain('email');
      expect(view).not.toHaveProperty('phone');
      expect(view).not.toHaveProperty('email');
    });

    it('throws 404 for an unknown slug', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);
      await expect(service.getPublicBySlug('nope')).rejects.toThrow(
        'introuvable',
      );
    });

    it('throws 404 when the slug belongs to a non-worker', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'e1',
        profile_type: ProfileType.EMPLOYER,
        portfolio_items: [],
      });
      await expect(service.getPublicBySlug('emp')).rejects.toThrow(
        'introuvable',
      );
    });
  });
});
