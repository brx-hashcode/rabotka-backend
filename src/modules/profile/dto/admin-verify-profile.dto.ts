import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export enum VerifyDecision {
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export class AdminVerifyProfileDto {
  @ApiProperty({
    description: 'Verification decision',
    enum: VerifyDecision,
  })
  @IsEnum(VerifyDecision)
  decision: VerifyDecision;

  @ApiPropertyOptional({ description: 'Rejection reason (required when rejecting)' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  reason?: string;
}
