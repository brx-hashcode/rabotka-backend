import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { InterviewMode } from '@prisma/client';
import { INTERVIEW_DURATIONS } from '../interview.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/** When, how long, how and where. */
export class InterviewSlotDto {
  @ApiPropertyOptional({
    example: '2026-11-03T09:00:00.000Z',
    description: 'One time; or `options` for 2 or 3 to choose from',
  })
  @ValidateIf((o: InterviewSlotDto) => !o.options?.length)
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({
    type: [String],
    description: '2 or 3 times; the candidate picks one through their link',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsDateString({}, { each: true })
  options?: string[];

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
    description:
      'A careers-page candidate, invited without a CV analysis (at the address they applied with)',
  })
  @IsOptional()
  @IsUUID('all')
  externalApplicationId?: string;

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

  @ApiPropertyOptional({
    description: 'With CONFIRMED: the time chosen, when several were offered',
  })
  @IsOptional()
  @IsUUID('all')
  slotId?: string;
}

/** « Inviter quelqu'un » into the visio. */
export class InterviewGuestDto {
  @ApiProperty({ example: 'Marie Ngoma' })
  @IsString()
  @MaxLength(80)
  name!: string;

  @ApiProperty({ example: 'marie@example.com' })
  @IsEmail()
  @MaxLength(200)
  email!: string;
}
