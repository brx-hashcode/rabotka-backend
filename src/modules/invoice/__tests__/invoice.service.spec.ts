import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InvoiceService } from '../invoice.service';
import { InvoiceReason } from '@prisma/client';

const baseProfile = {
  id: 'profile-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  email: 'alice@example.com',
  phone: '+242001',
};

const baseInvoice = {
  id: 'inv-1',
  profile_id: 'profile-1',
  payment_request_id: 'pr-1',
  amount: { toString: () => '5000' },
  reason: InvoiceReason.CONTACT_UNLOCK,
  related_entity_type: 'contact_unlock_attempt',
  related_entity_id: 'unlock-1',
  status: 'PENDING_DOWNLOAD',
  created_at: new Date('2026-01-01T10:00:00Z'),
  updated_at: new Date('2026-01-01T10:00:00Z'),
};

const baseTemplate = {
  id: 'tpl-invoice-1',
  category: 'INVOICE',
  file_url: 'https://cdn.example.com/invoice.docx',
};

function makePrisma() {
  return {
    invoice: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(baseInvoice),
      findMany: jest.fn().mockResolvedValue([baseInvoice]),
      update: jest
        .fn()
        .mockResolvedValue({ ...baseInvoice, status: 'DOWNLOADED' }),
    },
    document: {
      findFirst: jest.fn().mockResolvedValue(baseTemplate),
    },
    contactUnlockAttempt: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeDocumentService() {
  return {
    fillDocumentTemplateAsPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  };
}

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
}

describe('InvoiceService', () => {
  let service: InvoiceService;
  let prisma: ReturnType<typeof makePrisma>;
  let documentService: ReturnType<typeof makeDocumentService>;
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    documentService = makeDocumentService();
    redis = makeRedis();
    service = new InvoiceService(
      prisma as any,
      documentService as any,
      redis as any,
    );
  });

  describe('create()', () => {
    it('creates a new invoice', async () => {
      const result = await service.create({
        profileId: 'profile-1',
        paymentRequestId: 'pr-1',
        amount: 5000,
        reason: InvoiceReason.CONTACT_UNLOCK,
        relatedEntityType: 'contact_unlock_attempt',
        relatedEntityId: 'unlock-1',
      });
      expect(prisma.invoice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          profile_id: 'profile-1',
          payment_request_id: 'pr-1',
          amount: 5000,
          reason: InvoiceReason.CONTACT_UNLOCK,
        }),
      });
      expect(result.reason).toBe(InvoiceReason.CONTACT_UNLOCK);
    });

    it('returns existing invoice without creating a new one', async () => {
      prisma.invoice.findUnique.mockResolvedValue(baseInvoice);
      await service.create({
        profileId: 'profile-1',
        paymentRequestId: 'pr-1',
        amount: 5000,
        reason: InvoiceReason.CONTACT_UNLOCK,
      });
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });

  describe('listForProfile()', () => {
    it('returns mapped list of invoices', async () => {
      const result = await service.listForProfile('profile-1');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'inv-1',
        profileId: 'profile-1',
        reason: InvoiceReason.CONTACT_UNLOCK,
        status: 'PENDING_DOWNLOAD',
      });
    });

    it('returns empty array when no invoices', async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      const result = await service.listForProfile('profile-1');
      expect(result).toEqual([]);
    });
  });

  describe('download()', () => {
    beforeEach(() => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...baseInvoice,
        profile: baseProfile,
      });
    });

    it('returns PDF buffer for invoice owner', async () => {
      const result = await service.download('inv-1', 'profile-1');
      expect(documentService.fillDocumentTemplateAsPdf).toHaveBeenCalledWith(
        'tpl-invoice-1',
        expect.objectContaining({
          INVOICE_ID: expect.stringContaining('RBT-'),
          FIRST_NAME: 'Alice',
          LAST_NAME: 'Dupont',
          AMOUNT: '5000',
          REASON: 'Déverrouillage de contact',
        }),
      );
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.filename).toMatch(/Dupont.*\.pdf$/);
    });

    it('throws ForbiddenException for wrong profile', async () => {
      await expect(service.download('inv-1', 'stranger-99')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when invoice does not exist', async () => {
      prisma.invoice.findUnique.mockResolvedValue(null);
      await expect(service.download('missing', 'profile-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when no INVOICE template exists', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(service.download('inv-1', 'profile-1')).rejects.toThrow(
        'No INVOICE template found',
      );
    });

    it('marks invoice as DOWNLOADED after successful generation', async () => {
      await service.download('inv-1', 'profile-1');
      expect(prisma.invoice.update).toHaveBeenCalledWith({
        where: { id: 'inv-1' },
        data: { status: 'DOWNLOADED' },
      });
    });

    it('returns cached buffer without calling fillDocumentTemplateAsPdf on cache hit', async () => {
      const cachedBuf = Buffer.from('cached-invoice');
      redis.get.mockResolvedValue(cachedBuf.toString('base64'));
      const result = await service.download('inv-1', 'profile-1');
      expect(documentService.fillDocumentTemplateAsPdf).not.toHaveBeenCalled();
      expect(result.buffer).toEqual(cachedBuf);
    });

    it('stores generated PDF in Redis on cache miss', async () => {
      await service.download('inv-1', 'profile-1');
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('pdf:invoice:inv-1:tpl-invoice-1'),
        expect.any(String),
      );
    });

    it('uses invoice.created_at for GENERATED_DATE, not today', async () => {
      await service.download('inv-1', 'profile-1');
      expect(documentService.fillDocumentTemplateAsPdf).toHaveBeenCalledWith(
        'tpl-invoice-1',
        expect.objectContaining({
          GENERATED_DATE: new Date(baseInvoice.created_at).toLocaleDateString(
            'fr-FR',
          ),
        }),
      );
    });

    it('resolves related entity for worker type', async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...baseInvoice,
        profile: baseProfile,
        related_entity_type: 'worker',
        related_entity_id: 'worker-1',
        payment: null,
        payment_request: null,
      });
      (prisma as any).profile = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Bob', last_name: 'Smith' }),
      };
      const result = await service.download('inv-1', 'profile-1');
      expect(result.buffer).toBeInstanceOf(Buffer);
    });

    it('resolves related entity for contact_unlock_attempt type', async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...baseInvoice,
        profile: baseProfile,
        related_entity_type: 'contact_unlock_attempt',
        related_entity_id: 'unlock-1',
        payment: null,
        payment_request: null,
      });
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        worker_id: 'worker-2',
        worker: { first_name: 'Bob', last_name: 'Smith', id: 'worker-2' },
        employer: { first_name: 'Employer', last_name: 'One', id: 'emp-1' },
      });
      const result = await service.download('inv-1', 'profile-1');
      expect(result.buffer).toBeInstanceOf(Buffer);
    });

    it('resolves payment method via payment reference when no payment object', async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...baseInvoice,
        profile: baseProfile,
        payment: null,
        payment_request: { payment_reference: 'tx-ref-1' },
        related_entity_type: null,
        related_entity_id: null,
      });
      prisma.payment.findUnique.mockResolvedValue({
        payment_method: 'MOBILE_MONEY',
      });
      const result = await service.download('inv-1', 'profile-1');
      expect(result.buffer).toBeInstanceOf(Buffer);
    });

    it('uses payment method label from payment object', async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...baseInvoice,
        profile: baseProfile,
        payment: { payment_method: 'WALLET', transaction_id: 'tx-1' },
        payment_request: null,
        related_entity_type: null,
        related_entity_id: null,
      });
      const result = await service.download('inv-1', 'profile-1');
      expect(result.buffer).toBeInstanceOf(Buffer);
    });
  });

  describe('downloadAsAdmin()', () => {
    beforeEach(() => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...baseInvoice,
        profile: { ...baseProfile, profile_type: 'WORKER' },
        payment: null,
        payment_request: null,
        related_entity_type: null,
        related_entity_id: null,
      });
    });

    it('returns PDF buffer for admin', async () => {
      const result = await service.downloadAsAdmin('inv-1');
      expect(documentService.fillDocumentTemplateAsPdf).toHaveBeenCalled();
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.filename).toMatch(/\.pdf$/);
    });

    it('throws NotFoundException when invoice not found', async () => {
      prisma.invoice.findUnique.mockResolvedValue(null);
      await expect(service.downloadAsAdmin('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when no template found', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(service.downloadAsAdmin('inv-1')).rejects.toThrow(
        'No INVOICE template found',
      );
    });
  });

  describe('create() with paymentId idempotency', () => {
    it('returns existing invoice by paymentId without creating a new one', async () => {
      prisma.invoice.findUnique.mockResolvedValue(baseInvoice);
      await service.create({
        profileId: 'profile-1',
        paymentId: 'pay-1',
        amount: 5000,
        reason: InvoiceReason.PENALTY,
      });
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('creates when no existing by paymentId', async () => {
      prisma.invoice.findUnique.mockResolvedValue(null);
      await service.create({
        profileId: 'profile-1',
        paymentId: 'pay-new',
        amount: 3000,
        reason: InvoiceReason.OTHER,
      });
      expect(prisma.invoice.create).toHaveBeenCalled();
    });
  });
});
