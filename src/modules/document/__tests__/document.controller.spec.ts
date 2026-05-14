import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DocumentController, PublicDocumentController } from '../document.controller';
import { DocumentService } from '../document.service';
import { LogService } from '../../log/log.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const mockDocumentService = {
  createFromGoogleDocs: jest.fn().mockResolvedValue({ id: 'doc-1' }),
  createFromUpload: jest.fn().mockResolvedValue({ id: 'doc-1' }),
  list: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockResolvedValue({ id: 'doc-1', title: 'Updated' }),
  delete: jest.fn().mockResolvedValue(undefined),
  fillDocumentTemplate: jest.fn().mockResolvedValue(Buffer.from('docx')),
  fillDocumentTemplateAsPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
};

const mockLogService = {
  create: jest.fn().mockResolvedValue({}),
};

const adminReq = { user: { userId: 'admin-1' } };

describe('DocumentController', () => {
  let controller: DocumentController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [
        { provide: DocumentService, useValue: mockDocumentService },
        { provide: LogService, useValue: mockLogService },
      ],
    })
      .overrideGuard(AdminAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .compile();
    controller = module.get<DocumentController>(DocumentController);
  });

  it('createFromUrl creates document from Google Docs', async () => {
    const dto = { title: 'Policy', category: 'POLICY' as any, google_docs_url: 'https://docs.google.com/doc' };
    const result = await controller.createFromUrl(adminReq, dto);
    expect(mockDocumentService.createFromGoogleDocs).toHaveBeenCalled();
    expect(mockLogService.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'DOCUMENT_CREATED' }));
    expect(result.id).toBe('doc-1');
  });

  it('createFromUpload creates document from uploaded file', async () => {
    const dto = { title: 'Contract', category: 'CONTRACT' as any, file_url: 'https://storage/file.docx', mime_type: 'application/vnd.openxmlformats' };
    const result = await controller.createFromUpload(adminReq, dto);
    expect(mockDocumentService.createFromUpload).toHaveBeenCalled();
    expect(mockLogService.create).toHaveBeenCalled();
    expect(result.id).toBe('doc-1');
  });

  it('list returns documents', async () => {
    const result = await controller.list({});
    expect(mockDocumentService.list).toHaveBeenCalledWith({});
    expect(result).toEqual([]);
  });

  it('update updates a document and logs action', async () => {
    const result = await controller.update('doc-1', { title: 'Updated' }, adminReq);
    expect(mockDocumentService.update).toHaveBeenCalledWith('doc-1', { title: 'Updated' });
    expect(mockLogService.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'DOCUMENT_UPDATED' }));
    expect(result.title).toBe('Updated');
  });

  it('delete deletes document and logs action', async () => {
    const result = await controller.delete('doc-1', adminReq);
    expect(mockDocumentService.delete).toHaveBeenCalledWith('doc-1');
    expect(mockLogService.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'DOCUMENT_DELETED' }));
    expect(result).toEqual({ success: true });
  });

  it('fillDocx fills template and sends docx', async () => {
    const res = { setHeader: jest.fn(), send: jest.fn() } as any;
    await controller.fillDocx('doc-1', { data: { name: 'Alice' } }, res);
    expect(mockDocumentService.fillDocumentTemplate).toHaveBeenCalledWith('doc-1', { name: 'Alice' });
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(res.send).toHaveBeenCalled();
  });

  it('fillPdf fills template and sends pdf', async () => {
    const res = { setHeader: jest.fn(), send: jest.fn() } as any;
    await controller.fillPdf('doc-1', { data: {} }, res);
    expect(mockDocumentService.fillDocumentTemplateAsPdf).toHaveBeenCalledWith('doc-1', {});
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.send).toHaveBeenCalled();
  });
});

describe('PublicDocumentController', () => {
  let controller: PublicDocumentController;
  let prisma: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = {
      document: {
        findFirst: jest.fn(),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicDocumentController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    controller = module.get<PublicDocumentController>(PublicDocumentController);
  });

  it('getActivePolicy throws NotFoundException when no policy found', async () => {
    prisma.document.findFirst.mockResolvedValue(null);
    const res = { setHeader: jest.fn(), send: jest.fn(), json: jest.fn() } as any;
    await expect(controller.getActivePolicy(res)).rejects.toThrow(NotFoundException);
  });

  it('getActivePolicy returns JSON for non-pdf/md files', async () => {
    prisma.document.findFirst.mockResolvedValue({
      id: 'doc-1',
      title: 'Policy',
      category: 'POLICY',
      mime_type: 'text/html',
      file_url: 'https://storage/policy.html',
      created_at: new Date(),
    });
    const res = { setHeader: jest.fn(), send: jest.fn(), json: jest.fn() } as any;
    await controller.getActivePolicy(res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-1' }));
  });

  it('getActivePolicy fetches and returns markdown content', async () => {
    prisma.document.findFirst.mockResolvedValue({
      id: 'doc-1',
      title: 'Policy',
      category: 'POLICY',
      mime_type: 'text/markdown',
      file_url: 'https://storage/policy.md',
      created_at: new Date(),
    });
    global.fetch = jest.fn().mockResolvedValue({
      text: () => Promise.resolve('# Policy'),
    }) as any;
    const res = { setHeader: jest.fn().mockReturnThis(), send: jest.fn() } as any;
    await controller.getActivePolicy(res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/markdown; charset=utf-8');
    expect(res.send).toHaveBeenCalledWith('# Policy');
  });

  it('getActivePolicy fetches and returns PDF content', async () => {
    prisma.document.findFirst.mockResolvedValue({
      id: 'doc-1',
      title: 'Policy',
      category: 'POLICY',
      mime_type: 'application/pdf',
      file_url: 'https://storage/policy.pdf',
      created_at: new Date(),
    });
    global.fetch = jest.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    }) as any;
    const res = { setHeader: jest.fn().mockReturnThis(), send: jest.fn() } as any;
    await controller.getActivePolicy(res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
  });
});
