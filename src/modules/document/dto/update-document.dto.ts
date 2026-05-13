import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MinLength, IsEnum, IsOptional } from 'class-validator';
import { DocumentCategory } from '@prisma/client';

export class UpdateDocumentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @ApiPropertyOptional({ enum: DocumentCategory })
  @IsOptional()
  @IsEnum(DocumentCategory)
  category?: DocumentCategory;
}
