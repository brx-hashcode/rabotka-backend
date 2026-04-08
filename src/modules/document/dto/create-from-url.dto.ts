import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MinLength, IsEnum, IsOptional, IsUUID, IsUrl } from 'class-validator';
import { DocumentCategory } from '@prisma/client';

export class CreateDocumentFromUrlDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({ enum: DocumentCategory })
  @IsEnum(DocumentCategory)
  category: DocumentCategory;

  @ApiProperty({ description: 'Public Google Docs URL (must be shared as "Anyone with the link can view")' })
  @IsUrl()
  google_docs_url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  created_by?: string;
}
