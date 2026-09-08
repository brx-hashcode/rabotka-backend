import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClaimService } from '../claim.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClaimCommentsGateway } from '../../ws-notifications/claim-comments.gateway';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { WhatsAppLoginLinkService } from '../../auth/whatsapp-login-link.service';
import { ClaimAttachmentService } from '../claim-attachment.service';

const mockPrisma = {
  claim: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  claimComment: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    delete: jest.fn(),
  },
  profile: {
    findUnique: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockNotifications = {
  notifyClaimCreated: jest.fn().mockResolvedValue(undefined),
  notifyClaimInProgress: jest.fn().mockResolvedValue(undefined),
  notifyClaimCompleted: jest.fn().mockResolvedValue(undefined),
  notifyClaimRejected: jest.fn().mockResolvedValue(undefined),
  notifyClaimAssigned: jest.fn().mockResolvedValue(undefined),
  notifyClaimUnassigned: jest.fn().mockResolvedValue(undefined),
};

const mockEventEmitter = {
  emit: jest.fn(),
};

const mockGateway = {
  emitNewComment: jest.fn(),
  emitDeletedComment: jest.fn(),
};

const mockWhatsApp = {
  sendTemplateMessage: jest.fn().mockResolvedValue(true),
};

const mockLoginLink = {
  mint: jest.fn().mockResolvedValue('code-123'),
};

const mockAttachments = {
  uploadMany: jest.fn(),
  assertValidUrls: jest.fn().mockResolvedValue(undefined),
};

/**
 * The notification is fired with `void`, so the assertion has to run after the
 * microtasks it queues — the mint and the send — have both drained.
 */
const flushNotification = () => new Promise(process.nextTick);

/** A url shaped like one the upload route hands back. */
const imageUrl = 'https://cdn.test/claim-attachments/1757000000_ab12cd.jpg';

const now = new Date();

const baseClaim = {
  id: 'claim-1',
  title: 'Test Claim',
  description: 'Description',
  status: 'OPEN',
  attachment_urls: [],
  profile_id: 'profile-1',
  assigned_user_id: null,
  created_by_user_id: 'user-1',
  created_by_profile_id: null,
  created_at: now,
  updated_at: now,
  profile: {
    first_name: 'John',
    last_name: 'Doe',
    email: 'john@test.com',
    avatar_url: null,
  },
  assigned_user: null,
  created_by_user: {
    first_name: 'Admin',
    last_name: 'User',
    email: 'admin@test.com',
  },
  created_by_profile: null,
};

const baseComment = {
  id: 'comment-1',
  content: 'Test comment',
  attachment_urls: [],
  claim_id: 'claim-1',
  user_id: 'user-1',
  profile_id: null,
  created_by_type: 'user',
  created_at: now,
  updated_at: now,
  user: { first_name: 'Admin', last_name: 'User' },
  profile: null,
};

describe('ClaimService', () => {
  let service: ClaimService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationService, useValue: mockNotifications },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: ClaimCommentsGateway, useValue: mockGateway },
        { provide: WhatsAppService, useValue: mockWhatsApp },
        { provide: WhatsAppLoginLinkService, useValue: mockLoginLink },
        { provide: ClaimAttachmentService, useValue: mockAttachments },
      ],
    }).compile();
    service = module.get<ClaimService>(ClaimService);
  });

  describe('createForAdmin', () => {
    it('creates a claim and emits event', async () => {
      mockPrisma.claim.create.mockResolvedValue(baseClaim);
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com',
        first_name: 'John',
        last_name: 'Doe',
      });

      const result = await service.createForAdmin('user-1', {
        title: 'Test Claim',
        description: 'Description',
        profile_id: 'profile-1',
      });

      expect(result.id).toBe('claim-1');
      expect(mockEventEmitter.emit).toHaveBeenCalled();
      expect(mockPrisma.claim.create).toHaveBeenCalled();
    });

    it('creates a claim without notification if no profile email', async () => {
      mockPrisma.claim.create.mockResolvedValue(baseClaim);
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const result = await service.createForAdmin('user-1', {
        title: 'Test Claim',
        description: 'Description',
        profile_id: 'profile-1',
      });

      expect(result.id).toBe('claim-1');
    });
  });

  describe('listForAdmin', () => {
    it('returns paginated claims', async () => {
      mockPrisma.$transaction.mockResolvedValue([[baseClaim], 1]);

      const result = await service.listForAdmin({ page: 1, limit: 20 });

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('applies search filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.listForAdmin({
        q: 'test',
        status: ['OPEN' as any],
        profile_id: 'p1',
        assigned_user_id: 'u1',
      });

      expect(result.total).toBe(0);
    });
  });

  describe('getByIdForAdmin', () => {
    it('returns claim by id', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      const result = await service.getByIdForAdmin('claim-1');
      expect(result.id).toBe('claim-1');
    });

    it('throws NotFoundException if not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.getByIdForAdmin('claim-x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateForAdmin', () => {
    it('updates a claim', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claim.update.mockResolvedValue({
        ...baseClaim,
        title: 'Updated',
      });
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const result = await service.updateForAdmin('claim-1', {
        title: 'Updated',
      });
      expect(result.title).toBe('Updated');
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.updateForAdmin('x', {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('notifies profile on status change to IN_PROGRESS', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...baseClaim,
        status: 'OPEN',
      });
      mockPrisma.claim.update.mockResolvedValue({
        ...baseClaim,
        status: 'IN_PROGRESS',
      });
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com',
        first_name: 'John',
        last_name: 'Doe',
      });

      await service.updateForAdmin('claim-1', { status: 'IN_PROGRESS' as any });
      expect(mockNotifications.notifyClaimInProgress).toHaveBeenCalled();
    });

    it('notifies profile on status change to COMPLETED', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...baseClaim,
        status: 'OPEN',
      });
      mockPrisma.claim.update.mockResolvedValue({
        ...baseClaim,
        status: 'COMPLETED',
      });
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com',
        first_name: 'John',
        last_name: 'Doe',
      });

      await service.updateForAdmin('claim-1', { status: 'COMPLETED' as any });
      expect(mockNotifications.notifyClaimCompleted).toHaveBeenCalled();
    });

    it('notifies profile on status change to REJECTED', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...baseClaim,
        status: 'OPEN',
      });
      mockPrisma.claim.update.mockResolvedValue({
        ...baseClaim,
        status: 'REJECTED',
      });
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com',
        first_name: 'John',
        last_name: 'Doe',
      });

      await service.updateForAdmin('claim-1', { status: 'REJECTED' as any });
      expect(mockNotifications.notifyClaimRejected).toHaveBeenCalled();
    });

    it('notifies assigned user when assigned_user_id changes', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...baseClaim,
        assigned_user_id: null,
      });
      mockPrisma.claim.update.mockResolvedValue(baseClaim);
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        email: 'admin@test.com',
        first_name: 'Admin',
        last_name: 'User',
      });

      await service.updateForAdmin('claim-1', { assigned_user_id: 'user-2' });
      expect(mockNotifications.notifyClaimAssigned).toHaveBeenCalled();
    });

    it('notifies unassigned user when assigned_user_id removed', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...baseClaim,
        assigned_user_id: 'user-2',
      });
      mockPrisma.claim.update.mockResolvedValue(baseClaim);
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        email: 'admin@test.com',
        first_name: 'Admin',
        last_name: 'User',
      });

      await service.updateForAdmin('claim-1', { assigned_user_id: null });
      expect(mockNotifications.notifyClaimUnassigned).toHaveBeenCalled();
    });
  });

  describe('reorderForAdmin', () => {
    // The service runs inside `$transaction(cb)`; the mock prisma doubles as
    // the transaction client so the same jest.fn()s record the calls.
    function runInTransaction() {
      mockPrisma.$transaction.mockImplementation((cb: any) => cb(mockPrisma));
    }

    function positionOfLastUpdate(): number {
      const calls = mockPrisma.claim.update.mock.calls;
      return calls[calls.length - 1][0].data.position;
    }

    beforeEach(() => {
      runInTransaction();
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claim.update.mockResolvedValue(baseClaim);
    });

    it('lands on the midpoint between its two neighbours', async () => {
      mockPrisma.claim.findMany.mockResolvedValue([
        { id: 'a', position: 1000 },
        { id: 'b', position: 2000 },
      ]);

      await service.reorderForAdmin('claim-1', {
        status: 'COMPLETED' as any,
        index: 1,
      });

      expect(positionOfLastUpdate()).toBe(1500);
    });

    it('steps below the first claim when dropped at the top', async () => {
      mockPrisma.claim.findMany.mockResolvedValue([
        { id: 'a', position: 1000 },
      ]);

      await service.reorderForAdmin('claim-1', {
        status: 'COMPLETED' as any,
        index: 0,
      });

      expect(positionOfLastUpdate()).toBe(0);
    });

    it('steps above the last claim when dropped at the bottom', async () => {
      mockPrisma.claim.findMany.mockResolvedValue([
        { id: 'a', position: 1000 },
      ]);

      await service.reorderForAdmin('claim-1', {
        status: 'COMPLETED' as any,
        index: 1,
      });

      expect(positionOfLastUpdate()).toBe(2000);
    });

    it('opens an empty column at the first gap', async () => {
      mockPrisma.claim.findMany.mockResolvedValue([]);

      await service.reorderForAdmin('claim-1', {
        status: 'REJECTED' as any,
        index: 0,
      });

      expect(positionOfLastUpdate()).toBe(1000);
    });

    it('clamps an index past the end of the column', async () => {
      mockPrisma.claim.findMany.mockResolvedValue([
        { id: 'a', position: 1000 },
      ]);

      await service.reorderForAdmin('claim-1', {
        status: 'COMPLETED' as any,
        index: 99,
      });

      expect(positionOfLastUpdate()).toBe(2000);
    });

    it('renumbers the column when the gap is too small to halve', async () => {
      mockPrisma.claim.findMany.mockResolvedValue([
        { id: 'a', position: 1 },
        { id: 'b', position: 1.0000000001 },
        { id: 'c', position: 5000 },
      ]);

      await service.reorderForAdmin('claim-1', {
        status: 'COMPLETED' as any,
        index: 1,
      });

      const written = mockPrisma.claim.update.mock.calls.map(([arg]: any) => [
        arg.where.id,
        arg.data.position,
      ]);
      expect(written).toEqual([
        ['a', 1000],
        ['claim-1', 2000],
        ['b', 3000],
        ['c', 4000],
      ]);
    });

    it('throws if the claim does not exist', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);

      await expect(
        service.reorderForAdmin('nope', {
          status: 'COMPLETED' as any,
          index: 0,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteForAdmin', () => {
    it('deletes a claim', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claim.delete.mockResolvedValue(baseClaim);

      await service.deleteForAdmin('claim-1');
      expect(mockPrisma.claim.delete).toHaveBeenCalled();
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.deleteForAdmin('x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('addComment', () => {
    const claimWithOwner = {
      id: 'claim-1',
      title: 'Test',
      profile_id: 'profile-1',
      profile: { first_name: 'John', phone: '+242060000000' },
    };

    it('adds a comment', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
      mockPrisma.claimComment.create.mockResolvedValue(baseComment);

      const result = await service.addComment('claim-1', 'user-1', {
        content: 'Test comment',
      });
      expect(result.id).toBe('comment-1');
      expect(mockGateway.emitNewComment).toHaveBeenCalled();
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(
        service.addComment('x', 'u', { content: 'c' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('notifies the owner on WhatsApp with a code minted for the claim', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
      mockPrisma.claimComment.create.mockResolvedValue(baseComment);

      await service.addComment('claim-1', 'user-1', { content: 'On regarde' });
      await flushNotification();

      expect(mockLoginLink.mint).toHaveBeenCalledWith(
        'profile-1',
        'claims/claim-1',
      );
      expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242060000000',
        'claimCommented',
        {
          firstName: 'John',
          claimTitle: 'Test',
          excerpt: 'On regarde',
          loginCode: 'code-123',
        },
        'profile-1',
      );
    });

    it('still sends when no login code can be minted', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
      mockPrisma.claimComment.create.mockResolvedValue(baseComment);
      mockLoginLink.mint.mockResolvedValueOnce(null);

      await service.addComment('claim-1', 'user-1', { content: 'On regarde' });
      await flushNotification();

      // The template falls back to the bare claims path for a null code.
      expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242060000000',
        'claimCommented',
        expect.objectContaining({ loginCode: null }),
        'profile-1',
      );
    });

    it('sends nothing when the owner has no phone', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...claimWithOwner,
        profile: { first_name: 'John', phone: null },
      });
      mockPrisma.claimComment.create.mockResolvedValue(baseComment);

      await service.addComment('claim-1', 'user-1', { content: 'On regarde' });
      await flushNotification();

      expect(mockWhatsApp.sendTemplateMessage).not.toHaveBeenCalled();
      expect(mockLoginLink.mint).not.toHaveBeenCalled();
    });

    it('does not fail the comment when the send throws', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
      mockPrisma.claimComment.create.mockResolvedValue(baseComment);
      mockWhatsApp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('provider down'),
      );

      const result = await service.addComment('claim-1', 'user-1', {
        content: 'On regarde',
      });
      await flushNotification();

      expect(result.id).toBe('comment-1');
    });

    describe('attachments', () => {
      it('persists the urls and returns them mapped', async () => {
        mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
        mockPrisma.claimComment.create.mockResolvedValue({
          ...baseComment,
          attachment_urls: [imageUrl],
        });

        const result = await service.addComment('claim-1', 'user-1', {
          content: 'Voici',
          attachment_urls: [imageUrl],
        });

        expect(mockPrisma.claimComment.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ attachment_urls: [imageUrl] }),
          }),
        );
        expect(result.attachmentUrls).toEqual([imageUrl]);
      });

      it('validates the urls before writing anything', async () => {
        mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
        mockAttachments.assertValidUrls.mockRejectedValueOnce(
          new BadRequestException('Pièce jointe invalide'),
        );

        await expect(
          service.addComment('claim-1', 'user-1', {
            content: 'x',
            attachment_urls: ['https://evil.test/x.jpg'],
          }),
        ).rejects.toThrow(BadRequestException);
        expect(mockPrisma.claimComment.create).not.toHaveBeenCalled();
      });

      it('stores an image-only comment with empty content', async () => {
        mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
        mockPrisma.claimComment.create.mockResolvedValue({
          ...baseComment,
          content: '',
          attachment_urls: [imageUrl],
        });

        await service.addComment('claim-1', 'user-1', {
          attachment_urls: [imageUrl],
        });

        expect(mockPrisma.claimComment.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ content: '' }),
          }),
        );
      });

      it('sends NO WhatsApp notification for an image-only comment', async () => {
        // The template's body quotes the comment. With no text there is
        // nothing to quote, and the fallback copy says nothing worth a push.
        mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
        mockPrisma.claimComment.create.mockResolvedValue({
          ...baseComment,
          content: '',
          attachment_urls: [imageUrl],
        });

        await service.addComment('claim-1', 'user-1', {
          attachment_urls: [imageUrl],
        });
        await flushNotification();

        expect(mockWhatsApp.sendTemplateMessage).not.toHaveBeenCalled();
        expect(mockLoginLink.mint).not.toHaveBeenCalled();
      });

      it('still notifies when text accompanies the images', async () => {
        mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
        mockPrisma.claimComment.create.mockResolvedValue({
          ...baseComment,
          attachment_urls: [imageUrl],
        });

        await service.addComment('claim-1', 'user-1', {
          content: 'Regardez la photo',
          attachment_urls: [imageUrl],
        });
        await flushNotification();

        expect(mockWhatsApp.sendTemplateMessage).toHaveBeenCalledWith(
          '+242060000000',
          'claimCommented',
          expect.objectContaining({ excerpt: 'Regardez la photo' }),
          'profile-1',
        );
      });

      it('treats whitespace-only content as no text', async () => {
        mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
        mockPrisma.claimComment.create.mockResolvedValue({
          ...baseComment,
          content: '',
          attachment_urls: [imageUrl],
        });

        await service.addComment('claim-1', 'user-1', {
          content: '   ',
          attachment_urls: [imageUrl],
        });
        await flushNotification();

        expect(mockWhatsApp.sendTemplateMessage).not.toHaveBeenCalled();
      });

      it('puts the attachments on the socket payload', async () => {
        // Both frontends read the thread live; a comment that only reaches
        // them on refresh would look like a silent failure.
        mockPrisma.claim.findUnique.mockResolvedValue(claimWithOwner);
        mockPrisma.claimComment.create.mockResolvedValue({
          ...baseComment,
          attachment_urls: [imageUrl],
        });

        await service.addComment('claim-1', 'user-1', {
          content: 'Voici',
          attachment_urls: [imageUrl],
        });

        expect(mockGateway.emitNewComment).toHaveBeenCalledWith(
          'claim-1',
          expect.objectContaining({ attachmentUrls: [imageUrl] }),
        );
      });
    });
  });

  describe('listComments', () => {
    it('returns comments', async () => {
      mockPrisma.claimComment.findMany.mockResolvedValue([baseComment]);
      const result = await service.listComments('claim-1');
      expect(result).toHaveLength(1);
    });
  });

  describe('deleteComment', () => {
    it('deletes a comment', async () => {
      mockPrisma.claimComment.findFirst.mockResolvedValue(baseComment);
      mockPrisma.claimComment.delete.mockResolvedValue(baseComment);

      await service.deleteComment('claim-1', 'comment-1');
      expect(mockGateway.emitDeletedComment).toHaveBeenCalled();
    });

    it('throws if comment not found', async () => {
      mockPrisma.claimComment.findFirst.mockResolvedValue(null);
      await expect(service.deleteComment('claim-1', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createForProfile', () => {
    it('refuses a claim whose attachments are not vouched for', async () => {
      mockAttachments.assertValidUrls.mockRejectedValueOnce(
        new BadRequestException('Pièce jointe invalide'),
      );

      await expect(
        service.createForProfile('profile-1', {
          title: 'T',
          description: 'D',
          attachment_urls: ['https://evil.test/x.jpg'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.claim.create).not.toHaveBeenCalled();
    });

    it('creates claim as profile', async () => {
      mockPrisma.claim.create.mockResolvedValue(baseClaim);
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com',
        first_name: 'John',
        last_name: 'Doe',
      });

      const result = await service.createForProfile('profile-1', {
        title: 'Test Claim',
        description: 'Description',
      });
      expect(result.id).toBe('claim-1');
    });
  });

  describe('listForProfile', () => {
    it('returns paginated claims for profile', async () => {
      mockPrisma.$transaction.mockResolvedValue([[baseClaim], 1]);
      const result = await service.listForProfile('profile-1');
      expect(result.total).toBe(1);
    });
  });

  describe('getByIdForProfile', () => {
    it('returns claim for correct profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      const result = await service.getByIdForProfile('claim-1', 'profile-1');
      expect(result.id).toBe('claim-1');
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.getByIdForProfile('x', 'p')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws if claim belongs to different profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...baseClaim,
        profile_id: 'other',
      });
      await expect(
        service.getByIdForProfile('claim-1', 'profile-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listCommentsForProfile', () => {
    it('returns comments for claim owned by profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claimComment.findMany.mockResolvedValue([baseComment]);
      const result = await service.listCommentsForProfile(
        'claim-1',
        'profile-1',
      );
      expect(result).toHaveLength(1);
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.listCommentsForProfile('x', 'p')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws if claim belongs to different profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...baseClaim,
        profile_id: 'other',
      });
      await expect(
        service.listCommentsForProfile('claim-1', 'profile-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('addCommentAsProfile', () => {
    const ownedClaim = {
      id: 'claim-1',
      title: 'Test',
      profile_id: 'profile-1',
    };
    const profileComment = {
      ...baseComment,
      profile_id: 'profile-1',
      user_id: null,
      created_by_type: 'profile',
      user: null,
      profile: { first_name: 'John', last_name: 'Doe' },
    };

    it('persists attachments and returns them mapped', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(ownedClaim);
      mockPrisma.claimComment.create.mockResolvedValue({
        ...profileComment,
        attachment_urls: [imageUrl],
      });

      const result = await service.addCommentAsProfile('claim-1', 'profile-1', {
        content: 'Voici la photo',
        attachment_urls: [imageUrl],
      });

      expect(mockPrisma.claimComment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ attachment_urls: [imageUrl] }),
        }),
      );
      expect(result.attachmentUrls).toEqual([imageUrl]);
    });

    it('accepts an image-only reply', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(ownedClaim);
      mockPrisma.claimComment.create.mockResolvedValue({
        ...profileComment,
        content: '',
        attachment_urls: [imageUrl],
      });

      await service.addCommentAsProfile('claim-1', 'profile-1', {
        attachment_urls: [imageUrl],
      });

      expect(mockPrisma.claimComment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ content: '' }),
        }),
      );
    });

    it('rejects an unvouched url before writing', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(ownedClaim);
      mockAttachments.assertValidUrls.mockRejectedValueOnce(
        new BadRequestException('Pièce jointe invalide'),
      );

      await expect(
        service.addCommentAsProfile('claim-1', 'profile-1', {
          attachment_urls: ['https://evil.test/x.jpg'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.claimComment.create).not.toHaveBeenCalled();
    });

    it('checks ownership before touching attachments', async () => {
      // Order matters: validating first would tell a stranger whether a url is
      // one of ours before we have established they may post here at all.
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...ownedClaim,
        profile_id: 'someone-else',
      });

      await expect(
        service.addCommentAsProfile('claim-1', 'profile-1', {
          attachment_urls: [imageUrl],
        }),
      ).rejects.toThrow(NotFoundException);
      expect(mockAttachments.assertValidUrls).not.toHaveBeenCalled();
    });

    it('adds comment as profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        id: 'claim-1',
        title: 'Test',
        profile_id: 'profile-1',
      });
      mockPrisma.claimComment.create.mockResolvedValue({
        ...baseComment,
        profile_id: 'profile-1',
        user_id: null,
        created_by_type: 'profile',
        user: null,
        profile: { first_name: 'John', last_name: 'Doe' },
      });

      const result = await service.addCommentAsProfile('claim-1', 'profile-1', {
        content: 'Test',
      });
      expect(result.id).toBe('comment-1');
      expect(mockGateway.emitNewComment).toHaveBeenCalled();
    });

    it('does not notify the profile of its own comment', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        id: 'claim-1',
        title: 'Test',
        profile_id: 'profile-1',
      });
      mockPrisma.claimComment.create.mockResolvedValue({
        ...baseComment,
        profile_id: 'profile-1',
        user_id: null,
        created_by_type: 'profile',
        user: null,
        profile: { first_name: 'John', last_name: 'Doe' },
      });

      await service.addCommentAsProfile('claim-1', 'profile-1', {
        content: 'Test',
      });
      await flushNotification();

      expect(mockWhatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(
        service.addCommentAsProfile('x', 'p', { content: 'c' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws if claim belongs to different profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        id: 'claim-1',
        title: 'T',
        profile_id: 'other',
      });
      await expect(
        service.addCommentAsProfile('claim-1', 'profile-1', { content: 'c' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteCommentAsProfile', () => {
    it('deletes comment as profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claimComment.findFirst.mockResolvedValue({
        ...baseComment,
        profile_id: 'profile-1',
      });
      mockPrisma.claimComment.delete.mockResolvedValue(baseComment);

      await service.deleteCommentAsProfile('claim-1', 'comment-1', 'profile-1');
      expect(mockGateway.emitDeletedComment).toHaveBeenCalled();
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(
        service.deleteCommentAsProfile('x', 'c', 'p'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws if claim belongs to different profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({
        ...baseClaim,
        profile_id: 'other',
      });
      await expect(
        service.deleteCommentAsProfile('claim-1', 'c', 'profile-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws if comment not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claimComment.findFirst.mockResolvedValue(null);
      await expect(
        service.deleteCommentAsProfile('claim-1', 'x', 'profile-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
