import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
  IsUUID,
  IsUrl,
} from 'class-validator';
import { DocumentCategory } from '@prisma/client';

export class CreateDocumentFromUploadDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({ enum: DocumentCategory })
  @IsEnum(DocumentCategory)
  category: DocumentCategory;

  @ApiProperty({ description: 'Public URL of the already-uploaded file' })
  @IsUrl()
  file_url: string;

  @ApiProperty({ description: 'MIME type of the uploaded file' })
  @IsString()
  @MinLength(1)
  mime_type: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  created_by?: string;
}
