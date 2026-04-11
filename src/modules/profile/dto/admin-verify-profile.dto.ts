import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
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

  @ApiProperty({
    description:
      'Admin decision note (required for both approve and reject; stored on the profile)',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'La raison / la note est requise' })
  reason: string;
}
