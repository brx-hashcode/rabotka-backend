import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateClaimDto } from './dto/update-claim.dto';
import { AdminListClaimsDto } from './dto/admin-list-claims.dto';
import { ClaimStatus } from '@prisma/client';

export type AdminClaimItem = {
  id: string;
  title: string;
  description: string;
  status: ClaimStatus;
  attachmentUrls: string[];
  profileId: string;
  profileName: string | null;
  profileEmail: string | null;
  profileAvatarUrl: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  createdByUserId: string | null;
  createdByUserName: string | null;
  createdByProfileId: string | null;
  createdByProfileName: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapClaim(claim: any): AdminClaimItem {
  return {
    id: claim.id,
    title: claim.title,
    description: claim.description,
    status: claim.status,
    attachmentUrls: claim.attachment_urls,
    profileId: claim.profile_id,
    profileName: claim.profile
      ? `${claim.profile.first_name} ${claim.profile.last_name}`
      : null,
    profileEmail: claim.profile?.email ?? null,
    profileAvatarUrl: claim.profile?.avatar_url ?? null,
    assignedUserId: claim.assigned_user_id,
    assignedUserName: claim.assigned_user
      ? `${claim.assigned_user.first_name} ${claim.assigned_user.last_name}`
      : null,
    createdByUserId: claim.created_by_user_id,
    createdByUserName: claim.created_by_user
      ? `${claim.created_by_user.first_name} ${claim.created_by_user.last_name}`
      : null,
    createdByProfileId: claim.created_by_profile_id,
    createdByProfileName: claim.created_by_profile
      ? `${claim.created_by_profile.first_name} ${claim.created_by_profile.last_name}`
      : null,
    createdAt: claim.created_at.toISOString(),
    updatedAt: claim.updated_at.toISOString(),
  };
}

const claimInclude = {
  profile: {
    select: {
      first_name: true,
      last_name: true,
      email: true,
      avatar_url: true,
    },
  },
  assigned_user: { select: { first_name: true, last_name: true } },
  created_by_user: { select: { first_name: true, last_name: true } },
  created_by_profile: { select: { first_name: true, last_name: true } },
};

@Injectable()
export class ClaimService {
  constructor(private readonly prisma: PrismaService) {}

  async createForAdmin(
    userId: string,
    dto: CreateClaimDto,
  ): Promise<AdminClaimItem> {
    const claim = await this.prisma.claim.create({
      data: {
        title: dto.title,
        description: dto.description,
        profile_id: dto.profile_id,
        attachment_urls: dto.attachment_urls ?? [],
        assigned_user_id: dto.assigned_user_id ?? null,
        created_by_user_id: userId,
      },
      include: claimInclude,
    });
    return mapClaim(claim);
  }

  async listForAdmin(params: AdminListClaimsDto): Promise<{
    data: AdminClaimItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (params.q) {
      where.OR = [
        { title: { contains: params.q, mode: 'insensitive' } },
        { description: { contains: params.q, mode: 'insensitive' } },
        {
          profile: { first_name: { contains: params.q, mode: 'insensitive' } },
        },
        { profile: { last_name: { contains: params.q, mode: 'insensitive' } } },
      ];
    }

    if (params.status?.length) {
      where.status = { in: params.status as ClaimStatus[] };
    }

    if (params.profile_id) {
      where.profile_id = params.profile_id;
    }

    if (params.assigned_user_id) {
      where.assigned_user_id = params.assigned_user_id;
    }

    const [claims, total] = await this.prisma.$transaction([
      this.prisma.claim.findMany({
        where,
        include: claimInclude,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.claim.count({ where }),
    ]);

    return { data: claims.map(mapClaim), total, page, limit };
  }

  async getByIdForAdmin(id: string): Promise<AdminClaimItem> {
    const claim = await this.prisma.claim.findUnique({
      where: { id },
      include: claimInclude,
    });
    if (!claim) throw new NotFoundException('Claim not found');
    return mapClaim(claim);
  }

  async updateForAdmin(
    id: string,
    dto: UpdateClaimDto,
  ): Promise<AdminClaimItem> {
    const exists = await this.prisma.claim.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Claim not found');

    const data: any = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.attachment_urls !== undefined)
      data.attachment_urls = dto.attachment_urls;
    if ('assigned_user_id' in dto) data.assigned_user_id = dto.assigned_user_id;

    const claim = await this.prisma.claim.update({
      where: { id },
      data,
      include: claimInclude,
    });
    return mapClaim(claim);
  }

  async deleteForAdmin(id: string): Promise<void> {
    const exists = await this.prisma.claim.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Claim not found');
    await this.prisma.claim.delete({ where: { id } });
  }
}
