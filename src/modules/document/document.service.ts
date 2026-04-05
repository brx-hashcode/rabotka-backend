import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { ListDocumentsDto } from './dto/list-documents.dto';
import { DocumentCategory } from '@prisma/client';

export type AdminDocumentItem = {
  id: string;
  title: string;
  category: DocumentCategory;
  fileUrl: string;
  mimeType: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
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
  };
}

@Injectable()
export class DocumentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateDocumentDto): Promise<AdminDocumentItem> {
    const doc = await this.prisma.document.create({
      data: {
        title: dto.title,
        category: dto.category,
        file_url: dto.file_url,
        mime_type: dto.mime_type,
        created_by: dto.created_by ?? null,
      },
    });
    return mapDocument(doc);
  }

  async list(dto: ListDocumentsDto): Promise<{ data: AdminDocumentItem[]; total: number; page: number; limit: number }> {
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
    return mapDocument(doc);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.prisma.document.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Document not found');
    await this.prisma.document.delete({ where: { id } });
  }
}
