import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateClaimDto } from './dto/update-claim.dto';
import { AdminListClaimsDto } from './dto/admin-list-claims.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ClaimStatus } from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { ClaimCommentsGateway } from '../ws-notifications/claim-comments.gateway';

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
  assignedUserEmail: string | null;
  createdByUserId: string | null;
  createdByUserName: string | null;
  createdByUserEmail: string | null;
  createdByProfileId: string | null;
  createdByProfileName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminClaimCommentItem = {
  id: string;
  content: string;
  userId: string | null;
  userName: string | null;
  profileId: string | null;
  profileName: string | null;
  createdByType: 'user' | 'profile';
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
    assignedUserEmail: claim.assigned_user?.email ?? null,
    createdByUserId: claim.created_by_user_id,
    createdByUserName: claim.created_by_user
      ? `${claim.created_by_user.first_name} ${claim.created_by_user.last_name}`
      : null,
    createdByUserEmail: claim.created_by_user?.email ?? null,
    createdByProfileId: claim.created_by_profile_id,
    createdByProfileName: claim.created_by_profile
      ? `${claim.created_by_profile.first_name} ${claim.created_by_profile.last_name}`
      : null,
    createdAt: claim.created_at.toISOString(),
    updatedAt: claim.updated_at.toISOString(),
  };
}

function mapComment(c: any): AdminClaimCommentItem {
  return {
    id: c.id,
    content: c.content,
    userId: c.user_id,
    userName: c.user ? `${c.user.first_name} ${c.user.last_name}` : null,
    profileId: c.profile_id,
    profileName: c.profile
      ? `${c.profile.first_name} ${c.profile.last_name}`
      : null,
    createdByType: c.created_by_type || 'user',
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
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
  assigned_user: {
    select: { first_name: true, last_name: true, email: true },
  },
  created_by_user: {
    select: { first_name: true, last_name: true, email: true },
  },
  created_by_profile: { select: { first_name: true, last_name: true } },
};

@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly claimCommentsGateway: ClaimCommentsGateway,
  ) {}

  async createForAdmin(
    userId: string,
    dto: CreateClaimDto,
  ): Promise<AdminClaimItem> {
    const claim = await this.prisma.claim.create({
      data: {
        title: dto.title,
        description: dto.description,
        profile_id: dto.profile_id as string,
        attachment_urls: dto.attachment_urls ?? [],
        assigned_user_id: dto.assigned_user_id ?? null,
        created_by_user_id: userId,
      },
      include: claimInclude,
    });

    this.eventEmitter.emit(AdminNotificationEvent.CLAIM_CREATED, {
      event: AdminNotificationEvent.CLAIM_CREATED,
      title: 'Nouvelle réclamation',
      message: `Nouvelle réclamation "${dto.title}" créée par ${claim.profile ? `${claim.profile.first_name} ${claim.profile.last_name}` : 'un profil'}`,
      entityType: 'claim',
      entityId: String(claim.id),
      timestamp: new Date().toISOString(),
    });

    const profile = await this.prisma.profile.findUnique({
      where: { id: dto.profile_id },
      select: { email: true, first_name: true, last_name: true },
    });
    if (profile?.email) {
      void this.notifications
        .notifyClaimCreated(
          profile.email,
          `${profile.first_name} ${profile.last_name}`,
          dto.title,
        )
        .catch((err: unknown) =>
          this.logger.warn(
            `Notification failed`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }

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

    this.eventEmitter.emit(AdminNotificationEvent.CLAIM_UPDATED, {
      event: AdminNotificationEvent.CLAIM_UPDATED,
      title: 'Réclamation mise à jour',
      message: `La réclamation "${claim.title}" a été mise à jour${claim.profile ? ` (profil : ${claim.profile.first_name} ${claim.profile.last_name})` : ''}`,
      entityType: 'claim',
      entityId: String(claim.id),
      timestamp: new Date().toISOString(),
    });

    if (dto.status && dto.status !== exists.status) {
      const profile = await this.prisma.profile.findUnique({
        where: { id: exists.profile_id },
        select: { email: true, first_name: true, last_name: true },
      });
      const name = profile ? `${profile.first_name} ${profile.last_name}` : '';
      if (profile?.email) {
        if (dto.status === 'IN_PROGRESS') {
          void this.notifications
            .notifyClaimInProgress(profile.email, name, exists.title)
            .catch((err: unknown) =>
              this.logger.warn(
                `Notification failed`,
                err instanceof Error ? err.message : String(err),
              ),
            );
        } else if (dto.status === 'COMPLETED') {
          void this.notifications
            .notifyClaimCompleted(profile.email, name, exists.title)
            .catch((err: unknown) =>
              this.logger.warn(
                `Notification failed`,
                err instanceof Error ? err.message : String(err),
              ),
            );
        } else if (dto.status === 'REJECTED') {
          void this.notifications
            .notifyClaimRejected(profile.email, name, exists.title)
            .catch((err: unknown) =>
              this.logger.warn(
                `Notification failed`,
                err instanceof Error ? err.message : String(err),
              ),
            );
        }
      }
    }

    if (
      'assigned_user_id' in dto &&
      dto.assigned_user_id !== exists.assigned_user_id
    ) {
      if (dto.assigned_user_id) {
        const adminUser = await this.prisma.user.findUnique({
          where: { id: dto.assigned_user_id },
          select: { email: true, first_name: true, last_name: true },
        });
        if (adminUser?.email) {
          void this.notifications
            .notifyClaimAssigned(
              adminUser.email,
              `${adminUser.first_name} ${adminUser.last_name}`,
              exists.title,
            )
            .catch((err: unknown) =>
              this.logger.warn(
                `Notification failed`,
                err instanceof Error ? err.message : String(err),
              ),
            );
        }
      } else if (exists.assigned_user_id) {
        const previousUser = await this.prisma.user.findUnique({
          where: { id: exists.assigned_user_id },
          select: { email: true, first_name: true, last_name: true },
        });
        if (previousUser?.email) {
          void this.notifications
            .notifyClaimUnassigned(
              previousUser.email,
              `${previousUser.first_name} ${previousUser.last_name}`,
              exists.title,
            )
            .catch((err: unknown) =>
              this.logger.warn(
                `Notification failed`,
                err instanceof Error ? err.message : String(err),
              ),
            );
        }
      }
    }

    return mapClaim(claim);
  }

  async deleteForAdmin(id: string): Promise<void> {
    const exists = await this.prisma.claim.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Claim not found');
    await this.prisma.claim.delete({ where: { id } });
  }

  async addComment(
    claimId: string,
    userId: string,
    dto: CreateCommentDto,
  ): Promise<AdminClaimCommentItem> {
    const exists = await this.prisma.claim.findUnique({
      where: { id: claimId },
      select: { id: true, title: true },
    });
    if (!exists) throw new NotFoundException('Claim not found');
    const comment = await this.prisma.claimComment.create({
      data: {
        claim_id: claimId,
        content: dto.content,
        user_id: userId,
        created_by_type: 'user',
      },
      include: {
        user: { select: { first_name: true, last_name: true } },
        profile: { select: { first_name: true, last_name: true } },
      },
    });

    const authorName =
      `${comment.user?.first_name ?? ''} ${comment.user?.last_name ?? ''}`.trim();
    this.eventEmitter.emit(AdminNotificationEvent.CLAIM_COMMENTED, {
      event: AdminNotificationEvent.CLAIM_COMMENTED,
      title: 'Nouveau commentaire (admin)',
      message: `${authorName} a commenté la réclamation « ${exists.title} »`,
      entityType: 'claim',
      entityId: claimId,
      timestamp: new Date().toISOString(),
    });

    const mapped = mapComment(comment);
    this.claimCommentsGateway.emitNewComment(
      claimId,
      mapped as unknown as Record<string, unknown>,
    );
    return mapped;
  }

  async listComments(claimId: string): Promise<AdminClaimCommentItem[]> {
    const comments = await this.prisma.claimComment.findMany({
      where: { claim_id: claimId },
      include: {
        user: { select: { first_name: true, last_name: true } },
        profile: { select: { first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'asc' },
    });
    return comments.map(mapComment);
  }

  async deleteComment(claimId: string, commentId: string): Promise<void> {
    const comment = await this.prisma.claimComment.findFirst({
      where: { id: commentId, claim_id: claimId },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    await this.prisma.claimComment.delete({ where: { id: commentId } });
    this.claimCommentsGateway.emitDeletedComment(claimId, commentId);
  }

  /**
   * @param options.notifyProfile e-mail « Votre réclamation a été créée » au
   *   profil concerné. Vrai par défaut, parce que dans le cas normal c'est bien
   *   LUI qui vient de la déposer. À passer à faux quand le dossier est ouvert
   *   SUR lui et non PAR lui — un signalement de modération, par exemple :
   *   « Votre réclamation "Signalement automatique — langage abusif" a été
   *   créée avec succès » est faux sur le fond et absurde sur la forme.
   */
  async createForProfile(
    profileId: string,
    dto: CreateClaimDto,
    options?: { notifyProfile?: boolean },
  ): Promise<AdminClaimItem> {
    const claim = await this.prisma.claim.create({
      data: {
        title: dto.title,
        description: dto.description,
        profile_id: profileId,
        attachment_urls: dto.attachment_urls ?? [],
        assigned_user_id: dto.assigned_user_id ?? null,
      },
      include: claimInclude,
    });

    this.eventEmitter.emit(AdminNotificationEvent.CLAIM_CREATED, {
      event: AdminNotificationEvent.CLAIM_CREATED,
      title: 'Nouvelle réclamation',
      message: `Nouvelle réclamation "${dto.title}" créée par ${claim.profile ? `${claim.profile.first_name} ${claim.profile.last_name}` : 'un profil'}`,
      entityType: 'claim',
      entityId: String(claim.id),
      timestamp: new Date().toISOString(),
    });

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { email: true, first_name: true, last_name: true },
    });
    if (profile?.email && options?.notifyProfile !== false) {
      void this.notifications
        .notifyClaimCreated(
          profile.email,
          `${profile.first_name} ${profile.last_name}`,
          dto.title,
        )
        .catch((err: unknown) =>
          this.logger.warn(
            `Notification failed`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }

    return mapClaim(claim);
  }

  async listForProfile(profileId: string): Promise<{
    data: AdminClaimItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const [claims, total] = await this.prisma.$transaction([
      this.prisma.claim.findMany({
        where: { profile_id: profileId },
        include: claimInclude,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.claim.count({ where: { profile_id: profileId } }),
    ]);

    return { data: claims.map(mapClaim), total, page, limit };
  }

  async getByIdForProfile(
    id: string,
    profileId: string,
  ): Promise<AdminClaimItem> {
    const claim = await this.prisma.claim.findUnique({
      where: { id },
      include: claimInclude,
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.profile_id !== profileId) {
      throw new NotFoundException('Claim not found');
    }
    return mapClaim(claim);
  }

  async listCommentsForProfile(
    claimId: string,
    profileId: string,
  ): Promise<AdminClaimCommentItem[]> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.profile_id !== profileId) {
      throw new NotFoundException('Claim not found');
    }

    const comments = await this.prisma.claimComment.findMany({
      where: { claim_id: claimId },
      include: {
        user: { select: { first_name: true, last_name: true } },
        profile: { select: { first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'asc' },
    });
    return comments.map(mapComment);
  }

  async addCommentAsProfile(
    claimId: string,
    profileId: string,
    dto: CreateCommentDto,
  ): Promise<AdminClaimCommentItem> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      select: { id: true, title: true, profile_id: true },
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.profile_id !== profileId) {
      throw new NotFoundException('Claim not found');
    }

    const comment = await this.prisma.claimComment.create({
      data: {
        claim_id: claimId,
        content: dto.content,
        profile_id: profileId,
        created_by_type: 'profile',
      },
      include: {
        user: { select: { first_name: true, last_name: true } },
        profile: { select: { first_name: true, last_name: true } },
      },
    });

    const authorName =
      `${comment.profile?.first_name ?? ''} ${comment.profile?.last_name ?? ''}`.trim();
    this.eventEmitter.emit(AdminNotificationEvent.CLAIM_COMMENTED, {
      event: AdminNotificationEvent.CLAIM_COMMENTED,
      title: 'Nouveau commentaire (client)',
      message: `${authorName} a commenté la réclamation « ${claim.title} »`,
      entityType: 'claim',
      entityId: claimId,
      timestamp: new Date().toISOString(),
    });

    const mapped = mapComment(comment);
    this.claimCommentsGateway.emitNewComment(
      claimId,
      mapped as unknown as Record<string, unknown>,
    );
    return mapped;
  }

  async deleteCommentAsProfile(
    claimId: string,
    commentId: string,
    profileId: string,
  ): Promise<void> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.profile_id !== profileId) {
      throw new NotFoundException('Claim not found');
    }

    const comment = await this.prisma.claimComment.findFirst({
      where: { id: commentId, claim_id: claimId },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.profile_id !== profileId) {
      throw new NotFoundException('Comment not found');
    }
    await this.prisma.claimComment.delete({ where: { id: commentId } });
    this.claimCommentsGateway.emitDeletedComment(claimId, commentId);
  }
}
