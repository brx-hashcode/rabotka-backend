import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ContractService } from '../contract.service';
import { computeContractPublicReference } from '../contract-template.helpers';

const baseContract = {
  id: 'contract-1',
  application_id: 'app-1',
  template_version: 1,
  status: 'PENDING_DOWNLOAD',
  created_at: new Date('2026-01-01T10:00:00Z'),
  updated_at: new Date('2026-01-01T10:00:00Z'),
};

const baseWorker = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  email: 'alice@example.com',
  phone: '+242001',
};

const baseEmployer = {
  id: 'employer-1',
  first_name: 'Bob',
  last_name: 'Martin',
  email: 'bob@example.com',
  phone: '+242002',
};

const baseJobOffer = {
  id: 'job-1',
  employer_id: 'employer-1',
  title: 'Maçon',
  description: 'Travaux de construction',
  address: '10 Rue Brazza',
  amount: 50000,
  payment_flow: 'DAILY',
  scheduled_at: new Date('2026-02-01'),
  note: null as string | null,
  employer: baseEmployer,
};

const baseApplication = {
  id: 'app-1',
  worker_id: 'worker-1',
  worker: baseWorker,
  job_offer: baseJobOffer,
};

const baseContractWithRelations = {
  ...baseContract,
  application: baseApplication,
};

const baseTemplate = {
  id: 'tpl-1',
  category: 'CONTRACT',
  file_url: 'https://cdn.example.com/contract.docx',
};

function makePrisma() {
  return {
    contract: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(baseContract),
      update: jest
        .fn()
        .mockResolvedValue({ ...baseContract, status: 'DOWNLOADED' }),
    },
    document: {
      findFirst: jest.fn().mockResolvedValue(baseTemplate),
    },
  };
}

function makeDocumentService() {
  return {
    fillDocumentTemplateAsPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  };
}

describe('ContractService', () => {
  let service: ContractService;
  let prisma: ReturnType<typeof makePrisma>;
  let documentService: ReturnType<typeof makeDocumentService>;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    documentService = makeDocumentService();
    service = new ContractService(prisma as any, documentService as any);
  });

  describe('create()', () => {
    it('creates a new contract if none exists', async () => {
      const result = await service.create('app-1');
      expect(prisma.contract.create).toHaveBeenCalledWith({
        data: { application_id: 'app-1' },
      });
      expect(result.applicationId).toBe('app-1');
      expect(result.status).toBe('PENDING_DOWNLOAD');
    });

    it('returns existing contract without creating a new one', async () => {
      prisma.contract.findUnique.mockResolvedValue(baseContract);
      await service.create('app-1');
      expect(prisma.contract.create).not.toHaveBeenCalled();
    });
  });

  describe('download()', () => {
    beforeEach(() => {
      prisma.contract.findUnique.mockResolvedValue(baseContractWithRelations);
    });

    it('returns PDF buffer for worker', async () => {
      const result = await service.download('contract-1', 'worker-1');
      const expectedRef = computeContractPublicReference({
        contractId: baseContract.id,
        createdAt: baseContract.created_at,
      });
      expect(documentService.fillDocumentTemplateAsPdf).toHaveBeenCalledWith(
        'tpl-1',
        expect.objectContaining({
          CONTRACT_ID: expectedRef,
          CONTRACT_UUID: baseContract.id,
          START_DATE: '01/02/2026',
          END_DATE: '01/02/2026',
          DURATION: '1 jour',
          EMPLOYER_NAME: 'Bob Martin',
          WORKER_FULLNAME: 'Alice Dupont',
          JOB_LOCATION: '10 Rue Brazza',
          AMOUNT: '50 000',
          PAY_MODE: expect.stringContaining('journée'),
          WORKER_FIRST_NAME: 'Alice',
          EMPLOYER_FIRST_NAME: 'Bob',
          JOB_TITLE: 'Maçon',
        }),
      );
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.filename).toMatch(/\.pdf$/);
    });

    it('returns PDF buffer for employer', async () => {
      const result = await service.download('contract-1', 'employer-1');
      expect(result.buffer).toBeInstanceOf(Buffer);
    });

    it('throws ForbiddenException for unrelated profile', async () => {
      await expect(
        service.download('contract-1', 'stranger-99'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when contract does not exist', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);
      await expect(service.download('missing', 'worker-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when no CONTRACT template exists', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(service.download('contract-1', 'worker-1')).rejects.toThrow(
        'No CONTRACT template found',
      );
    });

    it('marks contract as DOWNLOADED after successful generation', async () => {
      await service.download('contract-1', 'worker-1');
      expect(prisma.contract.update).toHaveBeenCalledWith({
        where: { id: 'contract-1' },
        data: { status: 'DOWNLOADED' },
      });
    });
  });

  describe('findByApplication()', () => {
    it('returns contract when found', async () => {
      prisma.contract.findUnique.mockResolvedValue(baseContract);
      const result = await service.findByApplication('app-1');
      expect(result?.applicationId).toBe('app-1');
    });

    it('returns null when not found', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);
      const result = await service.findByApplication('missing');
      expect(result).toBeNull();
    });
  });
});
