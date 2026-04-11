import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateJobCategoryDto {
  @ApiProperty({ description: 'Category name', example: 'Nettoyage' })
  @Transform(({ value }) => value?.trim())
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'URL-friendly slug', example: 'nettoyage' })
  @Transform(({ value }) => value?.trim().toLowerCase())
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, { message: 'Slug must contain only lowercase letters, numbers and hyphens' })
  slug: string;

  @ApiPropertyOptional({ description: 'Short description' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Emoji or icon identifier', example: '🧹' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  icon?: string;
}
