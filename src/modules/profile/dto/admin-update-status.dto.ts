import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';

export class AdminUpdateStatusDto {
  @ApiProperty({
    description: 'New account status',
    enum: AccountStatus,
  })
  @IsEnum(AccountStatus)
  status: AccountStatus;
}
