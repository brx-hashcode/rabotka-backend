import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  IsEnum,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { DocumentCategory } from '@prisma/client';

export class CreateDocumentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty({ enum: DocumentCategory })
  @IsEnum(DocumentCategory)
  category: DocumentCategory;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  file_url: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  mime_type: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  created_by?: string;
}
