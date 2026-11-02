import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** A candidate's answer to one of the offer's questions. */
export class ApplyAnswerDto {
  @ApiProperty()
  @IsUUID()
  questionId!: string;

  @ApiProperty({
    description: '"yes" / "no", one of the options, or a short text',
  })
  @IsString()
  @MaxLength(300)
  value!: string;
}

/**
 * Applying. `answers` is left out by apps that do not ask the offer's
 * questions (the mobile app): the application then has none.
 */
export class ApplyToJobDto {
  @ApiPropertyOptional({ type: [ApplyAnswerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ApplyAnswerDto)
  answers?: ApplyAnswerDto[];
}
