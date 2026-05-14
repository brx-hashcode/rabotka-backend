import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ClaimService } from '../claim.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClaimCommentsGateway } from '../../ws-notifications/claim-comments.gateway';

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
  profile: { first_name: 'John', last_name: 'Doe', email: 'john@test.com', avatar_url: null },
  assigned_user: null,
  created_by_user: { first_name: 'Admin', last_name: 'User', email: 'admin@test.com' },
  created_by_profile: null,
};

const baseComment = {
  id: 'comment-1',
  content: 'Test comment',
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

      const result = await service.listForAdmin({ q: 'test', status: ['OPEN' as any], profile_id: 'p1', assigned_user_id: 'u1' });

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
      await expect(service.getByIdForAdmin('claim-x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateForAdmin', () => {
    it('updates a claim', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claim.update.mockResolvedValue({ ...baseClaim, title: 'Updated' });
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const result = await service.updateForAdmin('claim-1', { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.updateForAdmin('x', {})).rejects.toThrow(NotFoundException);
    });

    it('notifies profile on status change to IN_PROGRESS', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ ...baseClaim, status: 'OPEN' });
      mockPrisma.claim.update.mockResolvedValue({ ...baseClaim, status: 'IN_PROGRESS' });
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com', first_name: 'John', last_name: 'Doe',
      });

      await service.updateForAdmin('claim-1', { status: 'IN_PROGRESS' as any });
      expect(mockNotifications.notifyClaimInProgress).toHaveBeenCalled();
    });

    it('notifies profile on status change to COMPLETED', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ ...baseClaim, status: 'OPEN' });
      mockPrisma.claim.update.mockResolvedValue({ ...baseClaim, status: 'COMPLETED' });
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com', first_name: 'John', last_name: 'Doe',
      });

      await service.updateForAdmin('claim-1', { status: 'COMPLETED' as any });
      expect(mockNotifications.notifyClaimCompleted).toHaveBeenCalled();
    });

    it('notifies profile on status change to REJECTED', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ ...baseClaim, status: 'OPEN' });
      mockPrisma.claim.update.mockResolvedValue({ ...baseClaim, status: 'REJECTED' });
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com', first_name: 'John', last_name: 'Doe',
      });

      await service.updateForAdmin('claim-1', { status: 'REJECTED' as any });
      expect(mockNotifications.notifyClaimRejected).toHaveBeenCalled();
    });

    it('notifies assigned user when assigned_user_id changes', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ ...baseClaim, assigned_user_id: null });
      mockPrisma.claim.update.mockResolvedValue(baseClaim);
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        email: 'admin@test.com', first_name: 'Admin', last_name: 'User',
      });

      await service.updateForAdmin('claim-1', { assigned_user_id: 'user-2' });
      expect(mockNotifications.notifyClaimAssigned).toHaveBeenCalled();
    });

    it('notifies unassigned user when assigned_user_id removed', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ ...baseClaim, assigned_user_id: 'user-2' });
      mockPrisma.claim.update.mockResolvedValue(baseClaim);
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        email: 'admin@test.com', first_name: 'Admin', last_name: 'User',
      });

      await service.updateForAdmin('claim-1', { assigned_user_id: null });
      expect(mockNotifications.notifyClaimUnassigned).toHaveBeenCalled();
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
      await expect(service.deleteForAdmin('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('addComment', () => {
    it('adds a comment', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ id: 'claim-1', title: 'Test' });
      mockPrisma.claimComment.create.mockResolvedValue(baseComment);

      const result = await service.addComment('claim-1', 'user-1', { content: 'Test comment' });
      expect(result.id).toBe('comment-1');
      expect(mockGateway.emitNewComment).toHaveBeenCalled();
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.addComment('x', 'u', { content: 'c' })).rejects.toThrow(NotFoundException);
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
      await expect(service.deleteComment('claim-1', 'x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createForProfile', () => {
    it('creates claim as profile', async () => {
      mockPrisma.claim.create.mockResolvedValue(baseClaim);
      mockPrisma.profile.findUnique.mockResolvedValue({
        email: 'john@test.com', first_name: 'John', last_name: 'Doe',
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
      await expect(service.getByIdForProfile('x', 'p')).rejects.toThrow(NotFoundException);
    });

    it('throws if claim belongs to different profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ ...baseClaim, profile_id: 'other' });
      await expect(service.getByIdForProfile('claim-1', 'profile-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listCommentsForProfile', () => {
    it('returns comments for claim owned by profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claimComment.findMany.mockResolvedValue([baseComment]);
      const result = await service.listCommentsForProfile('claim-1', 'profile-1');
      expect(result).toHaveLength(1);
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.listCommentsForProfile('x', 'p')).rejects.toThrow(NotFoundException);
    });

    it('throws if claim belongs to different profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ ...baseClaim, profile_id: 'other' });
      await expect(service.listCommentsForProfile('claim-1', 'profile-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('addCommentAsProfile', () => {
    it('adds comment as profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ id: 'claim-1', title: 'Test', profile_id: 'profile-1' });
      mockPrisma.claimComment.create.mockResolvedValue({
        ...baseComment,
        profile_id: 'profile-1',
        user_id: null,
        created_by_type: 'profile',
        user: null,
        profile: { first_name: 'John', last_name: 'Doe' },
      });

      const result = await service.addCommentAsProfile('claim-1', 'profile-1', { content: 'Test' });
      expect(result.id).toBe('comment-1');
      expect(mockGateway.emitNewComment).toHaveBeenCalled();
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.addCommentAsProfile('x', 'p', { content: 'c' })).rejects.toThrow(NotFoundException);
    });

    it('throws if claim belongs to different profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ id: 'claim-1', title: 'T', profile_id: 'other' });
      await expect(service.addCommentAsProfile('claim-1', 'profile-1', { content: 'c' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteCommentAsProfile', () => {
    it('deletes comment as profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claimComment.findFirst.mockResolvedValue(baseComment);
      mockPrisma.claimComment.delete.mockResolvedValue(baseComment);

      await service.deleteCommentAsProfile('claim-1', 'comment-1', 'profile-1');
      expect(mockGateway.emitDeletedComment).toHaveBeenCalled();
    });

    it('throws if claim not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(null);
      await expect(service.deleteCommentAsProfile('x', 'c', 'p')).rejects.toThrow(NotFoundException);
    });

    it('throws if claim belongs to different profile', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue({ ...baseClaim, profile_id: 'other' });
      await expect(service.deleteCommentAsProfile('claim-1', 'c', 'profile-1')).rejects.toThrow(NotFoundException);
    });

    it('throws if comment not found', async () => {
      mockPrisma.claim.findUnique.mockResolvedValue(baseClaim);
      mockPrisma.claimComment.findFirst.mockResolvedValue(null);
      await expect(service.deleteCommentAsProfile('claim-1', 'x', 'profile-1')).rejects.toThrow(NotFoundException);
    });
  });
});
