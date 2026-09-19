import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePortfolioItemDto {
  /**
   * The publication's text. An empty string clears it, which is how a post
   * becomes images-only — so this has no MinLength: a 2-character caption is
   * a caption, and refusing it taught people nothing.
   */
  @ApiPropertyOptional({
    description: 'Texte de la publication. Chaîne vide pour le retirer.',
    maxLength: 1000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
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

  /**
   * Accepted and ignored. Publications no longer have a title.
   *
   * Kept for one release for the same reason as on the create DTO: the global
   * pipe runs with `forbidNonWhitelisted`, so an admin or web client still
   * running the previous bundle would 400 on every edit.
   *
   * @deprecated
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}
