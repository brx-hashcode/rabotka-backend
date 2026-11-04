import { ApiProperty } from '@nestjs/swagger';
import { CvChoice } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class CvPreferenceDto {
  @ApiProperty({ enum: CvChoice })
  @IsEnum(CvChoice)
  preferred!: CvChoice;
}
