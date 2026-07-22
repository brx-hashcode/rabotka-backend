import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePortfolioItemDto {
  @ApiPropertyOptional({
    description: 'Titre de la réalisation',
    maxLength: 120,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({
    description: 'Description de la réalisation',
    maxLength: 1000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: "Position d'affichage (ordre)",
    minimum: 0,
  })
  @Transform(({ value }) => (value != null ? Number(value) : value))
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
