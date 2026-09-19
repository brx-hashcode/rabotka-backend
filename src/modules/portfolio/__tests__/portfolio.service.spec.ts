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
      findUnique: AnyMock;
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
    contactRecord: { groupBy: AnyMock };
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
        findUnique: jest.fn(),
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
      contactRecord: { groupBy: jest.fn().mockResolvedValue([]) },
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
        description: 'Peinture — mur refait',
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
        { description: 'Peinture — mur refait en deux jours' },
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
        service.createItem('e1', { description: 'd' }, [makeFile()]),
      ).rejects.toThrow('travailleurs');
      expect(fileService.uploadToStorage).not.toHaveBeenCalled();
    });

    it('accepts a text-only publication, with no image at all', async () => {
      prisma.profile.findUnique
        .mockResolvedValueOnce({ id: 'w1', profile_type: ProfileType.WORKER })
        .mockResolvedValueOnce({
          portfolio_slug: null,
          first_name: 'Jean',
          last_name: 'Dupont',
        });
      prisma.portfolioItem.count.mockResolvedValue(0);
      prisma.portfolioItem.create.mockResolvedValue({
        id: 'item1',
        description: 'Disponible cette semaine à Bacongo',
        position: 0,
        created_at: new Date(),
        images: [],
      });
      prisma.profile.update.mockResolvedValue({ portfolio_slug: 'jean-abc' });

      const result = await service.createItem(
        'w1',
        { description: 'Disponible cette semaine à Bacongo' },
        [],
      );

      expect(fileService.uploadToStorage).not.toHaveBeenCalled();
      expect(result.images).toHaveLength(0);
    });

    it('accepts an images-only publication, with nothing written', async () => {
      prisma.profile.findUnique
        .mockResolvedValueOnce({ id: 'w1', profile_type: ProfileType.WORKER })
        .mockResolvedValueOnce({
          portfolio_slug: null,
          first_name: 'Jean',
          last_name: 'Dupont',
        });
      prisma.portfolioItem.count.mockResolvedValue(0);
      fileService.uploadToStorage.mockResolvedValueOnce({
        url: 'u1',
        key: 'k1',
      });
      prisma.portfolioItem.create.mockResolvedValue({
        id: 'item1',
        description: null,
        position: 0,
        created_at: new Date(),
        images: [{ id: 'i1', image_url: 'u1', position: 0 }],
      });
      prisma.profile.update.mockResolvedValue({ portfolio_slug: 'jean-abc' });

      const result = await service.createItem('w1', {}, [makeFile('a.jpg')]);

      expect(
        prisma.portfolioItem.create.mock.calls[0][0].data.description,
      ).toBeNull();
      expect(result.description).toBeNull();
    });

    it('rejects a publication that is neither text nor images', async () => {
      // The one rule left: a post has to be something.
      await expect(service.createItem('w1', {}, [])).rejects.toThrow(
        'texte ou au moins une image',
      );
      expect(fileService.uploadToStorage).not.toHaveBeenCalled();
    });

    it('treats whitespace-only text as no text', async () => {
      await expect(
        service.createItem('w1', { description: '   ' }, []),
      ).rejects.toThrow('texte ou au moins une image');
    });
  });

  describe('ownership', () => {
    it('updateItem throws 404 when the item is not owned by the caller', async () => {
      prisma.portfolioItem.findFirst.mockResolvedValue(null);
      await expect(
        service.updateItem('w1', 'item-x', { description: 'new' }),
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
        description: 'new',
        position: 0,
        created_at: new Date(),
        images: [],
      });
      await service.updateItem('w1', 'item1', { description: 'new' });
      expect(matchingService.indexWorkerProfile).toHaveBeenCalledWith('w1');
    });

    it('refuses to clear the text of a publication that has no images', async () => {
      prisma.portfolioItem.findFirst.mockResolvedValue({ id: 'item1' });
      prisma.portfolioImage.count.mockResolvedValue(0);
      await expect(
        service.updateItem('w1', 'item1', { description: '' }),
      ).rejects.toThrow('garder son texte');
      expect(prisma.portfolioItem.update).not.toHaveBeenCalled();
    });

    it('allows clearing the text when the publication still has photos', async () => {
      prisma.portfolioItem.findFirst.mockResolvedValue({ id: 'item1' });
      prisma.portfolioImage.count.mockResolvedValue(2);
      prisma.portfolioItem.update.mockResolvedValue({
        id: 'item1',
        description: null,
        position: 0,
        created_at: new Date(),
        images: [{ id: 'i1', image_url: 'u1', position: 0 }],
      });
      await service.updateItem('w1', 'item1', { description: '' });
      expect(
        prisma.portfolioItem.update.mock.calls[0][0].data.description,
      ).toBeNull();
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
      prisma.portfolioItem.findUnique.mockResolvedValue({
        description: 'Mur refait',
        _count: { images: 3 },
      });
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

    it('refuses to remove the last image of a publication with no text', async () => {
      // Otherwise the post is left as nothing at all — this is the only route
      // that could empty one out.
      prisma.portfolioItem.findFirst.mockResolvedValue({ id: 'item1' });
      prisma.portfolioItem.findUnique.mockResolvedValue({
        description: null,
        _count: { images: 1 },
      });
      prisma.portfolioImage.findFirst.mockResolvedValue({
        id: 'img1',
        storage_key: 'k9',
      });

      await expect(service.removeImage('w1', 'item1', 'img1')).rejects.toThrow(
        'garder au moins une image',
      );
      expect(prisma.portfolioImage.delete).not.toHaveBeenCalled();
      expect(storageService.delete).not.toHaveBeenCalled();
    });

    it('allows removing the last image when the publication has text', async () => {
      prisma.portfolioItem.findFirst.mockResolvedValue({ id: 'item1' });
      prisma.portfolioItem.findUnique.mockResolvedValue({
        description: 'Disponible cette semaine',
        _count: { images: 1 },
      });
      prisma.portfolioImage.findFirst.mockResolvedValue({
        id: 'img1',
        storage_key: 'k9',
      });
      prisma.portfolioImage.delete.mockResolvedValue({});

      await service.removeImage('w1', 'item1', 'img1');

      expect(prisma.portfolioImage.delete).toHaveBeenCalled();
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

  // Public because the WhatsApp bot builds /p/<slug> links for workers who may
  // never have uploaded a realization (and so have no slug yet).
  describe('ensurePortfolioSlug', () => {
    it('returns the existing slug without writing', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        portfolio_slug: 'jean-dupont-abc123',
        first_name: 'Jean',
        last_name: 'Dupont',
      });

      await expect(service.ensurePortfolioSlug('w1')).resolves.toBe(
        'jean-dupont-abc123',
      );
      expect(prisma.profile.update).not.toHaveBeenCalled();
    });

    it('mints and persists a slug when the profile has none', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        portfolio_slug: null,
        first_name: 'Jean',
        last_name: 'Dupont',
      });
      prisma.profile.update.mockImplementation((args: any) =>
        Promise.resolve({ portfolio_slug: args.data.portfolio_slug }),
      );

      const slug = await service.ensurePortfolioSlug('w1');

      expect(slug).toMatch(/^jean-dupont-[0-9a-f]{6}$/);
      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'w1' } }),
      );
    });

    it('throws 404 for an unknown profile', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);
      await expect(service.ensurePortfolioSlug('nope')).rejects.toThrow(
        'non trouvé',
      );
    });
  });
});
