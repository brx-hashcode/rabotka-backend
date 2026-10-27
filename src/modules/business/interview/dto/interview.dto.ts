import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { InterviewMode } from '@prisma/client';
import { INTERVIEW_DURATIONS } from '../interview.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/** When, how long, how and where. */
export class InterviewSlotDto {
  @ApiProperty({ example: '2026-11-03T09:00:00.000Z' })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ enum: INTERVIEW_DURATIONS })
  @Type(() => Number)
  @IsInt()
  @IsIn(INTERVIEW_DURATIONS)
  durationMinutes: number;

  @ApiProperty({ enum: InterviewMode })
  @IsEnum(InterviewMode)
  mode: InterviewMode;

  @ApiPropertyOptional({
    description: 'Address, video link, or the number to call',
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}

/** A new interview: a slot, and the candidate (an analysed CV or an application). */
export class CreateInterviewDto extends InterviewSlotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  cvResumeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  applicationId?: string;

  @ApiPropertyOptional({
    description: 'For an analysed CV: where to send the invitation',
  })
  @Transform(trim)
  @IsOptional()
  @IsEmail()
  candidateEmail?: string;
}

export class InterviewAnswerDto {
  @ApiProperty({ enum: ['CONFIRMED', 'DECLINED', 'RESCHEDULE_REQUESTED'] })
  @IsIn(['CONFIRMED', 'DECLINED', 'RESCHEDULE_REQUESTED'])
  answer: 'CONFIRMED' | 'DECLINED' | 'RESCHEDULE_REQUESTED';

  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
