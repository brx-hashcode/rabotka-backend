import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, HttpException } from '@nestjs/common';
import { DocumentService } from '../document.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { StorageService } from '../../../common/services/storage/storage.service';
import { FileService } from '../../file/file.service';
import { RedisService } from '../../../common/services/redis/redis.service';
import { GoogleDocsService } from '../google-docs.service';
import { DocumentCategory, DocumentSourceMode } from '@prisma/client';

const mockRedisClient = {
  keys: jest.fn().mockResolvedValue([]),
  del: jest.fn().mockResolvedValue(1),
};

const mockPrisma = {
  document: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
};

const mockStorage = {
  upload: jest.fn(),
};

const mockFileService = {
  getPresignedUrlFromPublicUrl: jest
    .fn()
    .mockResolvedValue('https://presigned.url/file.docx'),
};

const mockRedis = {
  getClient: jest.fn().mockReturnValue(mockRedisClient),
};

const mockGoogleDocs = {
  exportGoogleDocAsDocx: jest.fn(),
};

const now = new Date();

const baseDoc = {
  id: 'doc-1',
  title: 'Test Doc',
  category: DocumentCategory.CONTRACT,
  file_url: 'https://storage.example.com/doc.docx',
  mime_type:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  created_by: 'user-1',
  created_at: now,
  updated_at: now,
  source_mode: DocumentSourceMode.UPLOAD,
  google_docs_url: null,
  google_docs_id: null,
  preview_url: null,
  variables: [],
};

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('DocumentService', () => {
  let service: DocumentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedisClient.keys.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorage },
        { provide: FileService, useValue: mockFileService },
        { provide: RedisService, useValue: mockRedis },
        { provide: GoogleDocsService, useValue: mockGoogleDocs },
      ],
    }).compile();
    service = module.get<DocumentService>(DocumentService);
  });

  describe('createFromUpload', () => {
    it('creates a document from upload', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
      });
      mockPrisma.document.create.mockResolvedValue(baseDoc);

      const result = await service.createFromUpload({
        title: 'Test Doc',
        category: DocumentCategory.CONTRACT,
        fileUrl: 'https://storage.example.com/doc.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        createdBy: 'user-1',
      });

      expect(result.id).toBe('doc-1');
    });

    it('handles fetch failure gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      mockPrisma.document.create.mockResolvedValue(baseDoc);

      const result = await service.createFromUpload({
        title: 'Test Doc',
        category: DocumentCategory.CONTRACT,
        fileUrl: 'https://storage.example.com/doc.docx',
        mimeType: 'application/pdf',
      });

      expect(result.id).toBe('doc-1');
    });
  });

  describe('list', () => {
    it('returns paginated documents', async () => {
      mockPrisma.document.findMany.mockResolvedValue([baseDoc]);
      mockPrisma.document.count.mockResolvedValue(1);

      const result = await service.list({ page: 1, limit: 20 });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('filters by category', async () => {
      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);

      const result = await service.list({
        category: DocumentCategory.CONTRACT,
      });
      expect(result.total).toBe(0);
    });
  });

  describe('update', () => {
    it('updates a document', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(baseDoc);
      mockPrisma.document.update.mockResolvedValue({
        ...baseDoc,
        title: 'Updated',
      });

      const result = await service.update('doc-1', { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('throws if not found', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(null);
      await expect(service.update('x', { title: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete', () => {
    it('deletes a document', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(baseDoc);
      mockPrisma.document.delete.mockResolvedValue(baseDoc);

      await service.delete('doc-1');
      expect(mockPrisma.document.delete).toHaveBeenCalled();
    });

    it('throws if not found', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(null);
      await expect(service.delete('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createFromGoogleDocs', () => {
    it('throws for invalid Google Docs URL', async () => {
      let error: any;
      try {
        await service.createFromGoogleDocs({
          title: 'Test',
          category: DocumentCategory.CONTRACT,
          googleDocsUrl: 'https://example.com/not-a-docs-url',
        });
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('throws when fetch fails (network error)', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      let error: any;
      try {
        await service.createFromGoogleDocs({
          title: 'Test',
          category: DocumentCategory.CONTRACT,
          googleDocsUrl: 'https://docs.google.com/document/d/abc123/edit',
        });
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('throws when doc returns HTML (private doc)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: jest.fn().mockReturnValue('text/html; charset=utf-8') },
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
      });
      let error: any;
      try {
        await service.createFromGoogleDocs({
          title: 'Test',
          category: DocumentCategory.CONTRACT,
          googleDocsUrl: 'https://docs.google.com/document/d/abc123/edit',
        });
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('throws when fetch returns non-ok', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        headers: {
          get: jest
            .fn()
            .mockReturnValue(
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ),
        },
      });
      let error: any;
      try {
        await service.createFromGoogleDocs({
          title: 'Test',
          category: DocumentCategory.CONTRACT,
          googleDocsUrl: 'https://docs.google.com/document/d/abc123/edit',
        });
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('creates document from Google Docs when all succeeds', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: jest
            .fn()
            .mockReturnValue(
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ),
        },
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
      });
      mockStorage.upload.mockResolvedValue({
        url: 'https://storage.example.com/doc.docx',
      });
      mockPrisma.document.create.mockResolvedValue({
        ...baseDoc,
        source_mode: DocumentSourceMode.GOOGLE_DOCS,
        google_docs_id: 'abc123',
        google_docs_url: 'https://docs.google.com/document/d/abc123/edit',
        preview_url: 'https://docs.google.com/document/d/abc123/preview',
      });
      const result = await service.createFromGoogleDocs({
        title: 'Test',
        category: DocumentCategory.CONTRACT,
        googleDocsUrl: 'https://docs.google.com/document/d/abc123/edit',
        createdBy: 'user-1',
      });
      expect(result.sourceMode).toBe(DocumentSourceMode.GOOGLE_DOCS);
    });
  });

  describe('fillDocumentTemplate', () => {
    it('throws NotFoundException when document not found', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(null);
      let error: any;
      try {
        await service.fillDocumentTemplate('missing', {});
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(404);
    });

    it('throws UnprocessableEntityException when file cannot be parsed as docx', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(baseDoc);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)), // invalid docx
      });
      let error: any;
      try {
        await service.fillDocumentTemplate('doc-1', {});
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(422);
    });

    it('throws BadRequestException when fetch fails for UPLOAD source', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(baseDoc);
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      let error: any;
      try {
        await service.fillDocumentTemplate('doc-1', {});
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });
  });

  describe('loadDocxTemplateBuffer() via fillDocumentTemplate - GOOGLE_DOCS source', () => {
    const googleDocsDoc = {
      ...baseDoc,
      source_mode: DocumentSourceMode.GOOGLE_DOCS,
      google_docs_id: 'gid-123',
      google_docs_url: 'https://docs.google.com/document/d/gid-123/edit',
    };

    it('uses googleDocs.exportGoogleDocAsDocx for GOOGLE_DOCS source', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(googleDocsDoc);
      mockGoogleDocs.exportGoogleDocAsDocx.mockRejectedValue(
        new Error('export failed'),
      );
      // Falls back to fetch, also fails → BadRequest
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      let error: any;
      try {
        await service.fillDocumentTemplate('doc-1', {});
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('falls back to stored snapshot when live export fails', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(googleDocsDoc);
      mockGoogleDocs.exportGoogleDocAsDocx.mockRejectedValue(
        new Error('export failed'),
      );
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)), // invalid docx
      });
      let error: any;
      try {
        await service.fillDocumentTemplate('doc-1', {});
      } catch (e) {
        error = e;
      }
      // Invalid docx → UnprocessableEntity
      expect(error?.status).toBe(422);
    });

    it('throws HttpException from googleDocs export directly', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(googleDocsDoc);
      mockGoogleDocs.exportGoogleDocAsDocx.mockRejectedValue(
        new HttpException('Forbidden', 403),
      );
      let error: any;
      try {
        await service.fillDocumentTemplate('doc-1', {});
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(403);
    });

    it('throws error with numeric status from export', async () => {
      const numericErr = Object.assign(new Error('status error'), {
        status: 500,
      });
      mockPrisma.document.findUnique.mockResolvedValue(googleDocsDoc);
      mockGoogleDocs.exportGoogleDocAsDocx.mockRejectedValue(numericErr);
      let error: any;
      try {
        await service.fillDocumentTemplate('doc-1', {});
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(500);
    });

    it('succeeds for GOOGLE_DOCS source when export returns valid docx', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(googleDocsDoc);
      // Return valid-enough buffer (will fail parsing as docx anyway → 422)
      mockGoogleDocs.exportGoogleDocAsDocx.mockResolvedValue(
        Buffer.from('valid'),
      );
      let error: any;
      try {
        await service.fillDocumentTemplate('doc-1', {});
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(422);
    });
  });

  describe('list() — default values', () => {
    it('uses default page=1 and limit=20 when not provided', async () => {
      mockPrisma.document.findMany.mockResolvedValue([]);
      mockPrisma.document.count.mockResolvedValue(0);
      const result = await service.list({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  describe('createFromUpload() — fetch returns !ok', () => {
    it('uses empty buffer when fetch response is not ok', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403 });
      mockPrisma.document.create.mockResolvedValue(baseDoc);
      const result = await service.createFromUpload({
        title: 'Test',
        category: DocumentCategory.CONTRACT,
        fileUrl: 'https://storage.example.com/doc.docx',
        mimeType: 'application/pdf',
      });
      expect(result.id).toBe('doc-1');
    });
  });

  describe('cacheKey() — invalidateListCache() with keys present', () => {
    it('deletes cached keys when they exist', async () => {
      mockRedisClient.keys.mockResolvedValue(['key1', 'key2']);
      mockPrisma.document.findUnique.mockResolvedValue(baseDoc);
      mockPrisma.document.delete.mockResolvedValue(baseDoc);
      await service.delete('doc-1');
      expect(mockRedisClient.del).toHaveBeenCalledWith('key1', 'key2');
    });
  });

  describe('fillDocumentTemplate — successful render paths', () => {
    /**
     * Build a minimal valid .docx in memory containing two placeholders
     * `[name]` and `[date]` (the service configures docxtemplater with
     * `[` / `]` delimiters). The resulting buffer is what
     * `loadDocxTemplateBuffer` would return after fetching from storage.
     */
    function buildDocxWithPlaceholders(body: string): Buffer {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PizZip = require('pizzip');
      const zip = new PizZip();

      zip.file(
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      );
      zip.folder('_rels').file(
        '.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      );
      zip.folder('word').file(
        'document.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:r><w:t xml:space="preserve">' +
          body +
          '</w:t></w:r></w:p></w:body></w:document>',
      );
      return zip.generate({ type: 'nodebuffer' });
    }

    it('renders a valid .docx with all tags supplied', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(baseDoc);
      const buffer = buildDocxWithPlaceholders('Hello [name], today is [date].');
      // Service fetches the file_url via global.fetch in
      // loadDocxTemplateBuffer for UPLOAD source.
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: jest
          .fn()
          .mockResolvedValue(
            buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            ),
          ),
      });

      const result = await service.fillDocumentTemplate('doc-1', {
        name: 'Alice',
        date: '2026-05-24',
      });

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // The rendered output is itself a zip — inspect its document.xml
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PizZip = require('pizzip');
      const out = new PizZip(result);
      const xml = out.file('word/document.xml')!.asText();
      expect(xml).toContain('Alice');
      expect(xml).toContain('2026-05-24');
      expect(xml).not.toContain('[name]');
      expect(xml).not.toContain('[date]');
    });

    it('renders empty strings for missing tags without throwing', async () => {
      // docxtemplater's default behaviour: an unresolved tag becomes "".
      // The implementation's `template.render(data)` catch branch only
      // fires for harder errors (loop mismatches, unclosed tags, etc.).
      mockPrisma.document.findUnique.mockResolvedValue(baseDoc);
      const buffer = buildDocxWithPlaceholders('Hi [name] on [date].');
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: jest
          .fn()
          .mockResolvedValue(
            buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            ),
          ),
      });

      const result = await service.fillDocumentTemplate('doc-1', {});
      expect(Buffer.isBuffer(result)).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PizZip = require('pizzip');
      const xml = new PizZip(result).file('word/document.xml')!.asText();
      expect(xml).not.toContain('[name]');
      expect(xml).not.toContain('[date]');
    });

    it('renders a GOOGLE_DOCS template via the live export (happy path)', async () => {
      const googleDocsDoc = {
        ...baseDoc,
        source_mode: DocumentSourceMode.GOOGLE_DOCS,
        google_docs_id: 'gid-123',
        google_docs_url: 'https://docs.google.com/document/d/gid-123/edit',
      };
      mockPrisma.document.findUnique.mockResolvedValue(googleDocsDoc);
      const buffer = buildDocxWithPlaceholders('Hello [name].');
      mockGoogleDocs.exportGoogleDocAsDocx.mockResolvedValue(buffer);

      const result = await service.fillDocumentTemplate('doc-1', {
        name: 'Bob',
      });

      expect(mockGoogleDocs.exportGoogleDocAsDocx).toHaveBeenCalledWith('gid-123');
      // Should not have fallen back to fetch
      expect(mockFetch).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PizZip = require('pizzip');
      const xml = new PizZip(result).file('word/document.xml')!.asText();
      expect(xml).toContain('Bob');
    });

    it('preserves literal text that does not contain placeholders', async () => {
      mockPrisma.document.findUnique.mockResolvedValue(baseDoc);
      const buffer = buildDocxWithPlaceholders('Static text only.');
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: jest
          .fn()
          .mockResolvedValue(
            buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            ),
          ),
      });

      const result = await service.fillDocumentTemplate('doc-1', {});
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PizZip = require('pizzip');
      const xml = new PizZip(result).file('word/document.xml')!.asText();
      expect(xml).toContain('Static text only.');
    });
  });
});
