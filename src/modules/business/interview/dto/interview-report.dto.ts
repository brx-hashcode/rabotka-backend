import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MAX_NOTES } from '../interview-report';

export class InterviewNotesDto {
  @ApiProperty({ description: 'The team’s notes, typed or dictated' })
  @IsString()
  @MaxLength(MAX_NOTES)
  notes!: string;
}

export class EditInterviewReportDto {
  @ApiProperty({ description: 'The report’s sections, as edited by the team' })
  @IsObject()
  report!: Record<string, unknown>;
}

export class SendInterviewReportDto {
  @ApiPropertyOptional({
    description:
      'Team members to send it to; the hiring recipients when absent',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  memberIds?: string[];
}
