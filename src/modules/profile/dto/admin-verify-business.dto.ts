import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { VerifyDecision } from './admin-verify-profile.dto';

/** The decision on a business, or on one of its documents. */
export class AdminVerifyBusinessDto {
  @ApiProperty({ enum: VerifyDecision })
  @IsEnum(VerifyDecision)
  decision: VerifyDecision;

  @ApiPropertyOptional({
    description: 'Required to refuse; sent to the business with the decision.',
    maxLength: 1000,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
