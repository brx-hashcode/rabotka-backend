import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/**
 * The job the CVs are read against, sent with the files (multipart): one of
 * the business's offers, or a title and description written for the occasion.
 */
export class CreateCvScreeningDto {
  @ApiPropertyOptional({ description: 'One of the business’s offers' })
  @Transform(trim)
  @IsOptional()
  @IsUUID()
  offerId?: string;

  @ApiPropertyOptional({ description: 'When no offer: the job title' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  jobTitle?: string;

  @ApiPropertyOptional({
    description: 'When no offer: the missions and the profile sought',
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  jobText?: string;
}
