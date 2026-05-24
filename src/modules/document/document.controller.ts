import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { DocumentService } from './document.service';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { ListDocumentsDto } from './dto/list-documents.dto';
import { CreateDocumentFromUrlDto } from './dto/create-from-url.dto';
import { CreateDocumentFromUploadDto } from './dto/create-from-upload.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { LogService } from '../log/log.service';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { fetchWithTimeout } from '../../common/utils/fetch-with-timeout.util';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { DocumentCategory } from '@prisma/client';

@ApiTags('Admin – Documents')
@Controller('admin/documents')
@UseGuards(AdminAuthGuard, RolesGuard)
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly logService: LogService,
  ) {}

  /** Mode A — import from Google Docs URL */
  @Post('from-url')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Create document by importing from a public Google Docs URL',
  })
  @ApiResponse({
    status: 201,
    description: 'Document created from Google Docs',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid URL or document is private',
  })
  async createFromUrl(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateDocumentFromUrlDto,
  ) {
    const result = await this.documentService.createFromGoogleDocs({
      title: dto.title,
      category: dto.category,
      googleDocsUrl: dto.google_docs_url,
      createdBy: req.user.userId,
    });
    await this.logService.create({
      action: 'DOCUMENT_CREATED',
      entityType: 'Document',
      entityId: result.id,
      userId: req.user.userId,
      metadata: {
        title: dto.title,
        category: dto.category,
        source: 'google_docs',
      },
      ...extractRequestMeta(req),
    });
    return result;
  }

  /** Mode B — direct .docx upload (file already uploaded to storage via /file/upload) */
  @Post('from-upload')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Create document from an already-uploaded .docx file URL',
  })
  @ApiResponse({ status: 201, description: 'Document created from upload' })
  async createFromUpload(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateDocumentFromUploadDto,
  ) {
    const result = await this.documentService.createFromUpload({
      title: dto.title,
      category: dto.category,
      fileUrl: dto.file_url,
      mimeType: dto.mime_type,
      createdBy: req.user.userId,
    });
    await this.logService.create({
      action: 'DOCUMENT_CREATED',
      entityType: 'Document',
      entityId: result.id,
      userId: req.user.userId,
      metadata: { title: dto.title, category: dto.category, source: 'upload' },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'List all documents' })
  list(@Query() dto: ListDocumentsDto) {
    return this.documentService.list(dto);
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Update document title or category' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.documentService.update(id, dto);
    await this.logService.create({
      action: 'DOCUMENT_UPDATED',
      entityType: 'Document',
      entityId: id,
      userId: req.user?.userId,
      metadata: { fields: { ...dto } },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Delete(':id')
  @Roles(UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a document' })
  async delete(
    @Param('id') id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    await this.documentService.delete(id);
    await this.logService.create({
      action: 'DOCUMENT_DELETED',
      entityType: 'Document',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { success: true };
  }

  @Post(':id/fill/docx')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Fill template and return as DOCX' })
  async fillDocx(
    @Param('id') id: string,
    @Body() body: { data: Record<string, string> },
    @Res() res: Response,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const buffer = await this.documentService.fillDocumentTemplate(
      id,
      body.data ?? {},
    );
    await this.logService.create({
      action: 'DOCUMENT_TEMPLATE_FILLED',
      entityType: 'Document',
      entityId: id,
      userId: req.user?.userId,
      metadata: { format: 'docx' },
      ...extractRequestMeta(req),
    });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="document_${id}_filled.docx"`,
    );
    res.send(buffer);
  }

  @Post(':id/fill/pdf')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Fill template and return as PDF' })
  async fillPdf(
    @Param('id') id: string,
    @Body() body: { data: Record<string, string> },
    @Res() res: Response,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const buffer = await this.documentService.fillDocumentTemplateAsPdf(
      id,
      body.data ?? {},
    );
    await this.logService.create({
      action: 'DOCUMENT_TEMPLATE_FILLED',
      entityType: 'Document',
      entityId: id,
      userId: req.user?.userId,
      metadata: { format: 'pdf' },
      ...extractRequestMeta(req),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="document_${id}_filled.pdf"`,
    );
    res.send(buffer);
  }
}

@ApiTags('Public Documents')
@Controller('public/documents')
export class PublicDocumentController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('policy')
  @ApiOperation({
    summary: 'Get the active POLICY document (no authentication required)',
  })
  @ApiResponse({ status: 200, description: 'Active policy document content' })
  @ApiResponse({ status: 404, description: 'No active POLICY document found' })
  async getActivePolicy(@Res() res: Response) {
    const policy = await this.prisma.document.findFirst({
      where: { category: DocumentCategory.POLICY },
      orderBy: { created_at: 'desc' },
    });

    if (!policy) throw new NotFoundException('No active POLICY document found');

    const isMd = policy.file_url.endsWith('.md');
    const isPdf =
      policy.mime_type === 'application/pdf' ||
      policy.file_url.endsWith('.pdf');

    if (isMd) {
      const content = await fetchWithTimeout(policy.file_url, {}, 10_000).then(
        (r) => r.text(),
      );

      return res
        .setHeader('Content-Type', 'text/markdown; charset=utf-8')
        .send(content);
    }

    if (isPdf) {
      const fileRes = await fetchWithTimeout(policy.file_url, {}, 10_000);
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      return res
        .setHeader('Content-Type', 'application/pdf')
        .setHeader('Content-Disposition', `inline; filename="policy.pdf"`)
        .send(buffer);
    }

    return res.json({
      id: policy.id,
      title: policy.title,
      category: policy.category,
      mimeType: policy.mime_type,
      fileUrl: policy.file_url,
      createdAt: policy.created_at,
    });
  }
}
