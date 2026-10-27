import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

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

/** One question about an analysed CV. */
export class CvChatQuestionDto {
  @ApiPropertyOptional({ description: 'The question, in plain words' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  question: string;
}

/** The CVs of one screening to compare in a conversation. */
export class CvCompareDto {
  @ApiPropertyOptional({ type: [String], description: '2 to 5 scored CVs' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  resumeIds: string[];
}
