import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
  InternalServerErrorException,
  HttpException,
} from '@nestjs/common';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { StorageService } from '../../common/services/storage/storage.service';
import { RedisService } from '../../common/services/redis/redis.service';
import { GoogleDocsService } from './google-docs.service';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { ListDocumentsDto } from './dto/list-documents.dto';
import {
  DocumentCategory,
  DocumentSourceMode,
  type Document,
} from '@prisma/client';

export type AdminDocumentItem = {
  id: string;
  title: string;
  category: DocumentCategory;
  fileUrl: string;
  mimeType: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  sourceMode: DocumentSourceMode;
  googleDocsUrl: string | null;
  googleDocsId: string | null;
  previewUrl: string | null;
  variables: string[];
};

function mapDocument(doc: any): AdminDocumentItem {
  return {
    id: doc.id,
    title: doc.title,
    category: doc.category,
    fileUrl: doc.file_url,
    mimeType: doc.mime_type,
    createdBy: doc.created_by ?? null,
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
    sourceMode: doc.source_mode,
    googleDocsUrl: doc.google_docs_url ?? null,
    googleDocsId: doc.google_docs_id ?? null,
    previewUrl: doc.preview_url ?? null,
    variables: doc.variables ?? [],
  };
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function extractVariables(docxBuffer: Buffer): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const InspectModule = require('docxtemplater/js/inspect-module.js');
    const iModule = InspectModule();
    const zip = new PizZip(docxBuffer);
    const doc = new Docxtemplater(zip, {
      delimiters: { start: '[', end: ']' },
      paragraphLoop: true,
      linebreaks: true,
      modules: [iModule],
    });
    doc.compile();
    const tags: unknown = iModule.getAllTags();
    if (!tags || typeof tags !== 'object') return [];
    return Object.keys(tags as Record<string, unknown>);
  } catch {
    return [];
  }
}

function extractGoogleDocsId(url: string): string | null {
  const match = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(url);
  return match?.[1] ?? null;
}

const CACHE_PREFIX = 'docs:list:';
const CACHE_TTL_SEC = 5 * 24 * 60 * 60; // 5 days

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly googleDocs: GoogleDocsService,
  ) {}

  private cacheKey(dto: ListDocumentsDto): string {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const category = dto.category ?? 'ALL';
    return `${CACHE_PREFIX}${category}:${page}:${limit}`;
  }

  private async invalidateListCache(): Promise<void> {
    const client = this.redis.getClient();
    const keys = await client.keys(`${CACHE_PREFIX}*`);
    if (keys.length > 0) await client.del(...keys);
  }

  async createFromGoogleDocs(opts: {
    title: string;
    category: DocumentCategory;
    googleDocsUrl: string;
    createdBy?: string;
  }): Promise<AdminDocumentItem> {
    const googleDocsId = extractGoogleDocsId(opts.googleDocsUrl);
    if (!googleDocsId) {
      throw new BadRequestException(
        'Invalid Google Docs URL. Expected format: https://docs.google.com/document/d/{ID}/...',
      );
    }

    const exportUrl = `https://docs.google.com/feeds/download/documents/export/Export?id=${googleDocsId}&exportFormat=docx`;
    let docxBuffer: Buffer;
    try {
      const res = await fetch(exportUrl, { redirect: 'follow' });
      if (!res.ok) {
        throw new BadRequestException(
          `Could not download Google Doc (HTTP ${res.status}). Make sure the document is set to "Anyone with the link can view".`,
        );
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        throw new BadRequestException(
          'Google Doc is private or not accessible. Set sharing to "Anyone with the link can view" and try again.',
        );
      }
      docxBuffer = Buffer.from(await res.arrayBuffer());
    } catch (err: any) {
      if (err?.status) throw err;
      throw new BadRequestException(
        'Failed to reach Google Docs. Check the URL and document sharing settings.',
      );
    }

    const filename = `documents/${googleDocsId}_${Date.now()}.docx`;
    const uploadResult = await this.storage.upload(docxBuffer, filename, {
      mimeType: DOCX_MIME,
    });

    const variables = extractVariables(docxBuffer);

    const previewUrl = `https://docs.google.com/document/d/${googleDocsId}/preview`;

    const doc = await this.prisma.document.create({
      data: {
        title: opts.title,
        category: opts.category,
        file_url: uploadResult.url,
        mime_type: DOCX_MIME,
        created_by: opts.createdBy ?? null,
        source_mode: DocumentSourceMode.GOOGLE_DOCS,
        google_docs_id: googleDocsId,
        google_docs_url: opts.googleDocsUrl,
        preview_url: previewUrl,
        variables,
      },
    });

    return mapDocument(doc);
  }

  async createFromUpload(opts: {
    title: string;
    category: DocumentCategory;
    fileUrl: string;
    mimeType: string;
    createdBy?: string;
  }): Promise<AdminDocumentItem> {
    let docxBuffer: Buffer;
    try {
      const res = await fetch(opts.fileUrl);
      if (!res.ok) throw new Error('Could not fetch uploaded file');
      docxBuffer = Buffer.from(await res.arrayBuffer());
    } catch {
      docxBuffer = Buffer.alloc(0);
    }

    const variables = docxBuffer.length > 0 ? extractVariables(docxBuffer) : [];

    const previewUrl = `https://docs.google.com/gview?url=${encodeURIComponent(opts.fileUrl)}&embedded=true`;

    const doc = await this.prisma.document.create({
      data: {
        title: opts.title,
        category: opts.category,
        file_url: opts.fileUrl,
        mime_type: opts.mimeType,
        created_by: opts.createdBy ?? null,
        source_mode: DocumentSourceMode.UPLOAD,
        preview_url: previewUrl,
        variables,
      },
    });

    await this.invalidateListCache();
    return mapDocument(doc);
  }

  async list(dto: ListDocumentsDto): Promise<{
    data: AdminDocumentItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;
    const where = dto.category ? { category: dto.category } : {};

    const [docs, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.document.count({ where }),
    ]);

    return { data: docs.map(mapDocument), total, page, limit };
  }

  async update(id: string, dto: UpdateDocumentDto): Promise<AdminDocumentItem> {
    const existing = await this.prisma.document.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Document not found');

    const doc = await this.prisma.document.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.category !== undefined && { category: dto.category }),
      },
    });
    await this.invalidateListCache();
    return mapDocument(doc);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.prisma.document.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Document not found');
    await this.prisma.document.delete({ where: { id } });
    await this.invalidateListCache();
  }

  /**
   * For GOOGLE_DOCS sources, exports the live Google Doc as DOCX so structure matches the current
   * document in Drive. Falls back to the import-time snapshot at `file_url` if export fails.
   */
  private async loadDocxTemplateBuffer(doc: Document): Promise<Buffer> {
    if (
      doc.source_mode !== DocumentSourceMode.GOOGLE_DOCS ||
      !doc.google_docs_id
    ) {
      const res = await fetch(doc.file_url);
      if (!res.ok) {
        throw new BadRequestException('Template file content is missing');
      }
      return Buffer.from(await res.arrayBuffer());
    }

    try {
      return await this.googleDocs.exportGoogleDocAsDocx(doc.google_docs_id);
    } catch (err: unknown) {
      if (err instanceof HttpException) throw err;
      const status = (err as { status?: number })?.status;
      if (typeof status === 'number') throw err;
      this.logger.warn(
        `Live Google Doc export failed for ${doc.google_docs_id}; using stored DOCX snapshot from file_url`,
        err instanceof Error ? err.stack : undefined,
      );
      const res = await fetch(doc.file_url);
      if (!res.ok) {
        throw new BadRequestException(
          'Template file content is missing (live export failed and stored snapshot unavailable)',
        );
      }
      return Buffer.from(await res.arrayBuffer());
    }
  }

  async fillDocumentTemplate(
    id: string,
    data: Record<string, string>,
  ): Promise<Buffer> {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');

    const fileBuffer = await this.loadDocxTemplateBuffer(doc);

    let zip: PizZip;
    try {
      zip = new PizZip(fileBuffer);
    } catch {
      throw new UnprocessableEntityException('Failed to parse template file');
    }

    const template = new Docxtemplater(zip, {
      delimiters: { start: '[', end: ']' },
      paragraphLoop: true,
      linebreaks: true,
    });

    try {
      template.render(data);
    } catch (err: any) {
      const tags =
        err?.properties?.errors
          ?.map((e: any) => e.properties?.id)
          .filter(Boolean) ?? [];
      throw new UnprocessableEntityException(
        tags.length
          ? `Missing tags: ${tags.join(', ')}`
          : 'Template rendering failed',
      );
    }

    return template
      .getZip()
      .generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  async fillDocumentTemplateAsPdf(
    id: string,
    data: Record<string, string>,
  ): Promise<Buffer> {
    const docxBuffer = await this.fillDocumentTemplate(id, data);

    const libreOfficePdf = await this.convertWithLibreOffice(docxBuffer);
    if (libreOfficePdf) return libreOfficePdf;

    return this.convertWithPuppeteer(docxBuffer);
  }

  private async convertWithLibreOffice(
    docxBuffer: Buffer,
  ): Promise<Buffer | null> {
    const childProcess = await import('node:child_process');
    const util = await import('node:util');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const execFileAsync = util.promisify(childProcess.execFile);

    const candidates = [
      'soffice',
      '/usr/bin/soffice',
      '/usr/local/bin/soffice',
      String.raw`C:\Program Files\LibreOffice\program\soffice.exe`,
      String.raw`C:\Program Files (x86)\LibreOffice\program\soffice.exe`,
    ];

    let soffice: string | null = null;
    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version']);
        soffice = candidate;
        break;
      } catch {
        // not found, try next
      }
    }

    if (!soffice) return null;

    const tmp = os.tmpdir();
    const inputPath = path.join(tmp, `rabotka_${Date.now()}.docx`);
    const outputPath = inputPath.replace('.docx', '.pdf');

    try {
      await fs.writeFile(inputPath, docxBuffer);
      await execFileAsync(soffice, [
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        tmp,
        inputPath,
      ]);
      const pdfBuffer = await fs.readFile(outputPath);
      return pdfBuffer;
    } finally {
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    }
  }

  private async convertWithPuppeteer(docxBuffer: Buffer): Promise<Buffer> {
    try {
      const mammoth = await import('mammoth');
      const puppeteer = await import('puppeteer');

      const { value: html } = await mammoth.convertToHtml(
        { buffer: docxBuffer },
        {
          styleMap: [
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
          ],
        },
      );

      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      try {
        const page = await browser.newPage();
        await page.setContent(
          `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    @page { margin: 25mm 20mm; }
    * { box-sizing: border-box; }
    body {
      font-family: Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #000;
      margin: 0;
      padding: 0;
    }
    h1 { font-size: 18pt; font-weight: bold; margin: 0 0 12pt; }
    h2 { font-size: 14pt; font-weight: bold; margin: 10pt 0 8pt; }
    h3 { font-size: 12pt; font-weight: bold; margin: 8pt 0 6pt; }
    p  { margin: 0 0 8pt; }
    ul, ol { margin: 0 0 8pt; padding-left: 20pt; }
    li { margin-bottom: 4pt; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8pt; }
    td, th { border: 1px solid #ccc; padding: 4pt 6pt; font-size: 10pt; }
    img { max-width: 100%; height: auto; }
    strong, b { font-weight: bold; }
    em, i { font-style: italic; }
  </style>
</head>
<body>${html}</body>
</html>`,
          { waitUntil: 'networkidle0' },
        );
        const pdf = await page.pdf({
          format: 'A4',
          printBackground: true,
          displayHeaderFooter: false,
        });
        return Buffer.from(pdf);
      } finally {
        await browser.close();
      }
    } catch (err: any) {
      if (err?.status) throw err;
      throw new InternalServerErrorException('PDF conversion unavailable');
    }
  }
}
