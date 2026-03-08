import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';

export class AdminUpdateStatusDto {
  @ApiProperty({
    description: 'New account status',
    enum: AccountStatus,
  })
  @IsEnum(AccountStatus)
  status: AccountStatus;

  @ApiPropertyOptional({
    description: 'Reason for the status change',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
