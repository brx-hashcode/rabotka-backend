import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessDocumentType } from '@prisma/client';

/** The form fields sent with a business document's file (multipart). */
export class UploadBusinessDocumentDto {
  @ApiProperty({ enum: BusinessDocumentType })
  @IsEnum(BusinessDocumentType)
  documentType: BusinessDocumentType;

  @ApiPropertyOptional({
    description:
      'The current document this file replaces (a refused or pending one). Omitted: a document added alongside the others.',
  })
  @IsOptional()
  @IsUUID()
  replacesId?: string;
}
