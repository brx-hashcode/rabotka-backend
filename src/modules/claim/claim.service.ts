import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateClaimDto } from './dto/update-claim.dto';
import { ReorderClaimDto } from './dto/reorder-claim.dto';
import { AdminListClaimsDto } from './dto/admin-list-claims.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ClaimStatus, UserRole } from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { ClaimCommentsGateway } from '../ws-notifications/claim-comments.gateway';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';
import { claimDetailCtaPath } from '../../common/constants/whatsapp-templates';
import { ClaimAttachmentService } from './claim-attachment.service';

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
  /**
   * Who performed the assignment, and therefore the only admin allowed to
   * change it. Null when nobody is assigned, or when the assignment predates
   * the column — in which case anyone may change it.
   */
  assignedByUserId: string | null;
  assignedByUserName: string | null;
  createdByUserId: string | null;
  createdByUserName: string | null;
  createdByUserEmail: string | null;
  createdByProfileId: string | null;
  createdByProfileName: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminClaimCommentItem = {
  id: string;
  /** Empty for an image-only comment. Never null — see the schema comment. */
  content: string;
  attachmentUrls: string[];
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
    assignedByUserId: claim.assigned_by_user_id ?? null,
    assignedByUserName: claim.assigned_by_user
      ? `${claim.assigned_by_user.first_name} ${claim.assigned_by_user.last_name}`
      : null,
    createdByUserId: claim.created_by_user_id,
    createdByUserName: claim.created_by_user
      ? `${claim.created_by_user.first_name} ${claim.created_by_user.last_name}`
      : null,
    createdByUserEmail: claim.created_by_user?.email ?? null,
    createdByProfileId: claim.created_by_profile_id,
    createdByProfileName: claim.created_by_profile
      ? `${claim.created_by_profile.first_name} ${claim.created_by_profile.last_name}`
      : null,
    position: claim.position ?? 0,
    createdAt: claim.created_at.toISOString(),
    updatedAt: claim.updated_at.toISOString(),
  };
}

function mapComment(c: any): AdminClaimCommentItem {
  return {
    id: c.id,
    content: c.content,
    // `?? []` for the rows that predate the column — the migration defaults
    // them, but a `select` that omits the field would otherwise yield
    // undefined and reach both frontends as a missing key.
    attachmentUrls: c.attachment_urls ?? [],
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

/** Spacing between freshly numbered claims, and the step used at either end. */
const POSITION_GAP = 1000;

/** Below this, a midpoint would stop landing between its neighbours. */
const MIN_POSITION_GAP = 0.000001;

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
  assigned_by_user: {
    select: { first_name: true, last_name: true },
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
    private readonly whatsApp: WhatsAppService,
    private readonly loginLink: WhatsAppLoginLinkService,
    private readonly attachments: ClaimAttachmentService,
  ) {}

  async createForAdmin(
    userId: string,
    dto: CreateClaimDto,
  ): Promise<AdminClaimItem> {
    await this.attachments.assertValidUrls(dto.attachment_urls);

    const claim = await this.prisma.claim.create({
      data: {
        title: dto.title,
        description: dto.description,
        profile_id: dto.profile_id as string,
        attachment_urls: dto.attachment_urls ?? [],
        assigned_user_id: dto.assigned_user_id ?? null,
        // Assigning at creation makes the creator the assigner, so the rule
        // applies from the first save rather than from the first edit.
        assigned_by_user_id: dto.assigned_user_id ? userId : null,
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
        // Board order. `position` is manual rank within a column; created_at
        // breaks the tie so claims that have never been dragged (all default
        // to 0) still read newest-first.
        orderBy: [{ position: 'asc' }, { created_at: 'desc' }],
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

  /**
   * @param actorUserId the admin making the change. Required: an assignment may
   *   only be undone by whoever made it, so the caller's identity is part of
   *   the authorisation, not just of the audit trail.
   */
  async updateForAdmin(
    id: string,
    dto: UpdateClaimDto,
    actorUserId: string,
  ): Promise<AdminClaimItem> {
    const exists = await this.prisma.claim.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Claim not found');

    await this.attachments.assertValidUrls(dto.attachment_urls);

    const data: any = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.attachment_urls !== undefined)
      data.attachment_urls = dto.attachment_urls;

    // Deliberately NOT `'assigned_user_id' in dto`. The DTO is a class, and
    // `useDefineForClassFields` — implied by target ES2023 — emits every
    // declared property as a real class field, so `plainToInstance` hands us an
    // instance carrying all five keys whatever the client sent. The `in` test
    // was therefore always true, and a status-only edit read as an
    // unassignment: it ran the guard below (403 for anyone but the assigner and
    // SUPER_ADMIN, so nobody else could complete a claim) and then cleared the
    // assignee it had never been asked to touch.
    //
    // `undefined` means the field was absent; an explicit `null` still counts
    // as a change, because `null !== undefined`.
    const changesAssignee =
      dto.assigned_user_id !== undefined &&
      (dto.assigned_user_id ?? null) !== exists.assigned_user_id;

    if (changesAssignee) {
      await this.assertMayChangeAssignee(exists, actorUserId);
      data.assigned_user_id = dto.assigned_user_id ?? null;
      // The actor becomes the new assigner, and clearing the assignee clears
      // the assigner with it — otherwise a stale name would keep guarding a
      // claim nobody is on.
      data.assigned_by_user_id = dto.assigned_user_id ? actorUserId : null;
    }

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

    // Same flag as the write above, rather than a second key-presence test:
    // that one told the previous assignee they had been taken off a claim
    // every time somebody merely moved it to another column.
    if (changesAssignee) {
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

  /**
   * Move a claim to `index` of the `status` column, where `index` counts the
   * claim itself — the slot it should occupy once it has landed.
   *
   * The client sends an index rather than a raw position because it cannot
   * know what the column looks like for everyone else: two admins dragging at
   * once would compute their midpoints from stale neighbours. The neighbours
   * are read here, inside the transaction, so the second move lands against
   * the first one's result.
   */
  async reorderForAdmin(
    id: string,
    dto: ReorderClaimDto,
  ): Promise<AdminClaimItem> {
    return this.prisma.$transaction(async (tx) => {
      const exists = await tx.claim.findUnique({ where: { id } });
      if (!exists) throw new NotFoundException('Claim not found');

      const siblings = await tx.claim.findMany({
        where: { status: dto.status, id: { not: id } },
        orderBy: [{ position: 'asc' }, { created_at: 'desc' }],
        select: { id: true, position: true },
      });

      const index = Math.max(0, Math.min(dto.index, siblings.length));
      const before = index > 0 ? siblings[index - 1].position : null;
      const after = index < siblings.length ? siblings[index].position : null;

      // Halving a gap ~50 times exhausts double precision and the midpoint
      // stops landing between its neighbours. Rare — it takes that many drops
      // into the same slot — but it corrupts the order silently, so spread the
      // whole column out again and take the extra writes.
      if (
        before !== null &&
        after !== null &&
        after - before < MIN_POSITION_GAP
      ) {
        const ordered = siblings.map((s) => s.id);
        ordered.splice(index, 0, id);
        for (const [i, claimId] of ordered.entries()) {
          await tx.claim.update({
            where: { id: claimId },
            data: {
              position: (i + 1) * POSITION_GAP,
              ...(claimId === id ? { status: dto.status } : {}),
            },
          });
        }
        const rebalanced = await tx.claim.findUnique({
          where: { id },
          include: claimInclude,
        });
        return mapClaim(rebalanced);
      }

      let position: number;
      if (before !== null && after !== null) {
        position = (before + after) / 2;
      } else if (after !== null) {
        position = after - POSITION_GAP;
      } else if (before !== null) {
        position = before + POSITION_GAP;
      } else {
        position = POSITION_GAP;
      }

      const claim = await tx.claim.update({
        where: { id },
        data: { status: dto.status, position },
        include: claimInclude,
      });

      return mapClaim(claim);
    });
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
      select: {
        id: true,
        title: true,
        profile_id: true,
        // For the WhatsApp notification below. Selected here rather than
        // fetched after the insert: this query already runs.
        profile: { select: { first_name: true, phone: true } },
      },
    });
    if (!exists) throw new NotFoundException('Claim not found');

    await this.attachments.assertValidUrls(dto.attachment_urls);

    // Empty rather than null for an image-only comment: the column is NOT NULL
    // and every reader treats `content` as a string.
    const content = dto.content?.trim() ?? '';

    const comment = await this.prisma.claimComment.create({
      data: {
        claim_id: claimId,
        content,
        attachment_urls: dto.attachment_urls ?? [],
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

    // Text only. An image-only reply sends nothing: the template's third
    // variable is the comment itself, and with no text there is nothing to
    // quote — `freeTextVar` would fall back to "Consultez le détail dans
    // l'application", which is a notification that says nothing.
    //
    // Fire-and-forget, like every other notification here: WhatsApp being down
    // must not fail an admin's comment, which is already saved.
    if (content) {
      void this.notifyOwnerOfAdminComment(claimId, exists, content).catch(
        (err: unknown) =>
          this.logger.warn(
            'Claim comment WhatsApp notification failed',
            err instanceof Error ? err.message : String(err),
          ),
      );
    }

    return mapped;
  }

  /**
   * Tells the complainant that an admin answered.
   *
   * Admin comments only. `addCommentAsProfile` is the user writing TO us, and
   * notifying them of their own message would be noise.
   */
  private async notifyOwnerOfAdminComment(
    claimId: string,
    claim: {
      title: string;
      profile_id: string;
      profile: { first_name: string; phone: string | null } | null;
    },
    content: string,
  ): Promise<void> {
    const phone = claim.profile?.phone?.trim();
    if (!phone) return;

    // Minted HERE rather than in the outbound processor: `sendTemplateMessage`
    // talks to the provider directly and never touches the queue, so
    // `withLoginCode` — the only other filler of a url-suffix var — never runs.
    // Null for a non-mintable status (suspended, banned); the template then
    // falls back to the bare claims path.
    const loginCode = await this.loginLink
      .mint(claim.profile_id, claimDetailCtaPath(claimId))
      .catch(() => null);

    await this.whatsApp.sendTemplateMessage(
      phone,
      'claimCommented',
      {
        firstName: claim.profile?.first_name ?? '',
        claimTitle: claim.title,
        excerpt: content,
        loginCode,
      },
      claim.profile_id,
    );
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

  /**
   * Whoever assigned a claim is the only one who may change that assignment.
   *
   * Without this, an admin handed a claim could simply set it back to
   * "Unassigned" — which looks like the work was redistributed, but is really
   * the claim quietly falling off everyone's list.
   *
   * It covers reassignment as well as clearing: allowing only the latter to be
   * blocked would leave the rule bypassable in one click, by handing the claim
   * to a colleague instead of dropping it.
   *
   * Two ways through:
   *   - no known assigner (`assigned_by_user_id` null) — assignments made
   *     before this column existed, which must not become unfixable
   *   - SUPER_ADMIN — somebody has to be able to move a claim on when the
   *     assigner has left the team or is away
   */
  private async assertMayChangeAssignee(
    claim: {
      assigned_user_id: string | null;
      assigned_by_user_id: string | null;
    },
    actorUserId: string,
  ): Promise<void> {
    if (!claim.assigned_user_id) return;
    if (!claim.assigned_by_user_id) return;
    if (claim.assigned_by_user_id === actorUserId) return;

    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { role: true },
    });
    if (actor?.role === UserRole.SUPER_ADMIN) return;

    const assigner = await this.prisma.user.findUnique({
      where: { id: claim.assigned_by_user_id },
      select: { first_name: true, last_name: true },
    });
    const name = assigner
      ? `${assigner.first_name} ${assigner.last_name}`.trim()
      : "l'administrateur qui l'a assignée";

    throw new ForbiddenException(
      `Seul ${name} peut modifier cette assignation.`,
    );
  }

  /**
   * Deletes the row, NOT the stored objects it points at.
   *
   * Deliberate, and the same choice `deleteForAdmin` already makes for a
   * claim's own attachments. A url is not proof of sole ownership: a client
   * that retried an upload leaves two rows on one key, and deleting the object
   * for one of them breaks the other. Orphaned objects cost storage; deleting a
   * live one loses evidence. A sweeper that reconciles keys against rows is the
   * right fix and is tracked separately.
   */
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
    await this.attachments.assertValidUrls(dto.attachment_urls);

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

    await this.attachments.assertValidUrls(dto.attachment_urls);

    const comment = await this.prisma.claimComment.create({
      data: {
        claim_id: claimId,
        content: dto.content?.trim() ?? '',
        attachment_urls: dto.attachment_urls ?? [],
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

  /** Stored objects are left in place — see `deleteComment`. */
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
