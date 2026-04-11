import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CreateJobCategoryDto } from './dto/create-job-category.dto';
import { UpdateJobCategoryDto } from './dto/update-job-category.dto';

@Injectable()
export class JobCategoryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.jobCategory.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        icon: true,
        created_at: true,
      },
    });
  }

  async create(dto: CreateJobCategoryDto) {
    const existing = await this.prisma.jobCategory.findUnique({
      where: { slug: dto.slug },
    });
    if (existing)
      throw new ConflictException(
        `A category with slug "${dto.slug}" already exists`,
      );

    return this.prisma.jobCategory.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        icon: true,
        created_at: true,
      },
    });
  }

  async update(id: string, dto: UpdateJobCategoryDto) {
    await this.findOneOrFail(id);

    if (dto.slug) {
      const conflict = await this.prisma.jobCategory.findFirst({
        where: { slug: dto.slug, NOT: { id } },
      });
      if (conflict)
        throw new ConflictException(
          `A category with slug "${dto.slug}" already exists`,
        );
    }

    return this.prisma.jobCategory.update({
      where: { id },
      data: dto,
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        icon: true,
        created_at: true,
      },
    });
  }

  async remove(id: string) {
    await this.findOneOrFail(id);
    await this.prisma.jobCategory.delete({ where: { id } });
  }

  private async findOneOrFail(id: string) {
    const category = await this.prisma.jobCategory.findUnique({
      where: { id },
    });
    if (!category) throw new NotFoundException(`Category not found`);
    return category;
  }
}
