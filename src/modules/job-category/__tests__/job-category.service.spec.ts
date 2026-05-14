import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { JobCategoryService } from '../job-category.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

const mockPrisma = {
  jobCategory: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

const mockCategory = {
  id: 'cat-1',
  name: 'Plomberie',
  slug: 'plomberie',
  description: 'Plomberie description',
  icon: null,
  created_at: new Date(),
};

describe('JobCategoryService', () => {
  let service: JobCategoryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobCategoryService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<JobCategoryService>(JobCategoryService);
  });

  describe('findAll', () => {
    it('returns all categories', async () => {
      mockPrisma.jobCategory.findMany.mockResolvedValue([mockCategory]);
      const result = await service.findAll();
      expect(result).toHaveLength(1);
    });
  });

  describe('create', () => {
    it('creates a category', async () => {
      mockPrisma.jobCategory.findUnique.mockResolvedValue(null);
      mockPrisma.jobCategory.create.mockResolvedValue(mockCategory);

      const result = await service.create({ name: 'Plomberie', slug: 'plomberie' });
      expect(result.id).toBe('cat-1');
    });

    it('throws ConflictException if slug already exists', async () => {
      mockPrisma.jobCategory.findUnique.mockResolvedValue(mockCategory);
      await expect(service.create({ name: 'X', slug: 'plomberie' })).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('updates a category', async () => {
      mockPrisma.jobCategory.findUnique.mockResolvedValue(mockCategory);
      mockPrisma.jobCategory.findFirst.mockResolvedValue(null);
      mockPrisma.jobCategory.update.mockResolvedValue({ ...mockCategory, name: 'Updated' });

      const result = await service.update('cat-1', { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });

    it('throws NotFoundException if not found', async () => {
      mockPrisma.jobCategory.findUnique.mockResolvedValue(null);
      await expect(service.update('x', { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException if slug conflict', async () => {
      mockPrisma.jobCategory.findUnique.mockResolvedValue(mockCategory);
      mockPrisma.jobCategory.findFirst.mockResolvedValue({ id: 'other', slug: 'new-slug' });
      await expect(service.update('cat-1', { slug: 'new-slug' })).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('removes a category', async () => {
      mockPrisma.jobCategory.findUnique.mockResolvedValue(mockCategory);
      mockPrisma.jobCategory.delete.mockResolvedValue(mockCategory);

      await service.remove('cat-1');
      expect(mockPrisma.jobCategory.delete).toHaveBeenCalled();
    });

    it('throws NotFoundException if not found', async () => {
      mockPrisma.jobCategory.findUnique.mockResolvedValue(null);
      await expect(service.remove('x')).rejects.toThrow(NotFoundException);
    });
  });
});
