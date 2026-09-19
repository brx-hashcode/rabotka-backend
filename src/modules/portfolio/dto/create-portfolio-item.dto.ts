import { Transform } from 'class-transformer';
import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePortfolioItemDto {
  @ApiPropertyOptional({
    description:
      'Texte de la publication. Facultatif si au moins une image est envoyée.',
    maxLength: 1000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /**
   * Accepted and ignored. Publications no longer have a title.
   *
   * Only here because the global pipe runs with `forbidNonWhitelisted`, so
   * dropping the field outright would 400 every create coming from a web
   * client still running the previous bundle — which is every open tab until
   * it reloads. Delete this once that traffic has rolled over.
   *
   * @deprecated
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}
