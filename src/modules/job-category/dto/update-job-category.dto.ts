import { IsString, IsOptional, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateJobCategoryDto {
  @ApiPropertyOptional({ description: 'Category name' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'URL-friendly slug' })
  @Transform(({ value }) => value?.trim().toLowerCase())
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase letters, numbers and hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({ description: 'Short description' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Emoji or icon identifier' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  icon?: string;
}
