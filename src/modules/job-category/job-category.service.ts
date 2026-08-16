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

  /**
   * The admin list, with how many rows actually reference each domain.
   *
   * Separate from `findAll` on purpose: that one also serves the PUBLIC
   * `/job-categories` endpoint, which is hit on every signup and offer form and
   * has no business paying for aggregate subselects — or exposing how thin a
   * domain's coverage is.
   *
   * `profiles` is the legacy single-category link and `profile_categories` the
   * many-to-many that replaced it. Both are counted because both are still
   * populated, and a domain that looks unused on one may be busy on the other.
   */
  async findAllForAdmin() {
    const [categories, workerCounts] = await Promise.all([
      this.prisma.jobCategory.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          icon: true,
          created_at: true,
          _count: { select: { job_offers: true } },
        },
      }),
      // A profile can be linked to a domain twice over — once through the
      // legacy `category_id` column and once through the `profile_categories`
      // join that replaced it. Counting the two relations separately and adding
      // them double-counts anyone on both; taking the larger under-counts
      // anyone on only one. Neither is "how many workers list this trade", so
      // the union is taken in SQL where DISTINCT can actually see across both.
      this.prisma.$queryRaw<{ category_id: string; count: bigint }[]>`
        SELECT category_id, COUNT(DISTINCT profile_id) AS count
        FROM (
          SELECT category_id, id AS profile_id
          FROM profiles
          WHERE category_id IS NOT NULL AND deleted_at IS NULL
          UNION
          SELECT pc.category_id, pc.profile_id
          FROM profile_categories pc
          JOIN profiles p ON p.id = pc.profile_id
          WHERE p.deleted_at IS NULL
        ) links
        GROUP BY category_id
      `,
    ]);

    const workersByCategory = new Map(
      workerCounts.map((row) => [row.category_id, Number(row.count)]),
    );

    return categories.map(({ _count, ...category }) => ({
      ...category,
      jobOffersCount: _count.job_offers,
      workersCount: workersByCategory.get(category.id) ?? 0,
    }));
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
