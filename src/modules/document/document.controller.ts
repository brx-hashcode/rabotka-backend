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
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { DocumentService } from './document.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { ListDocumentsDto } from './dto/list-documents.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { LogService } from '../log/log.service';

@Controller('admin/documents')
@UseGuards(AdminAuthGuard)
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly logService: LogService,
  ) {}

  @Post()
  async create(@Req() req: any, @Body() dto: CreateDocumentDto) {
    const result = await this.documentService.create({
      ...dto,
      created_by: req.user.userId,
    });
    await this.logService.create({
      action: 'DOCUMENT_CREATED',
      entityType: 'Document',
      entityId: result.id,
      userId: req.user.userId,
      metadata: { title: dto.title, category: dto.category },
    });
    return result;
  }

  @Get()
  list(@Query() dto: ListDocumentsDto) {
    return this.documentService.list(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateDocumentDto, @Req() req: any) {
    const result = await this.documentService.update(id, dto);
    await this.logService.create({
      action: 'DOCUMENT_UPDATED',
      entityType: 'Document',
      entityId: id,
      userId: req.user?.userId,
      metadata: { fields: dto },
    });
    return result;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('id') id: string, @Req() req: any) {
    await this.documentService.delete(id);
    await this.logService.create({
      action: 'DOCUMENT_DELETED',
      entityType: 'Document',
      entityId: id,
      userId: req.user?.userId,
    });
    return { success: true };
  }
}
