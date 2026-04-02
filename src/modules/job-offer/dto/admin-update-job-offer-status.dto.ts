import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { JobOfferStatus } from '@prisma/client';

export class AdminUpdateJobOfferStatusDto {
  @ApiProperty({ enum: JobOfferStatus })
  @IsEnum(JobOfferStatus)
  status: JobOfferStatus;
}
