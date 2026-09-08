import {
  IsBoolean,
  IsOptional,
  IsString,
  IsNumber,
  IsInt,
  IsEnum,
  IsDateString,
  IsUUID,
  ValidateIf,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentFlow,
  EmploymentType,
} from '@prisma/client';
import { LocationDto } from '../../../common/dto/location.dto';

export class AdminUpdateJobOfferDto extends LocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(100)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description:
      "The offer's closing date. Send null to clear it — only meaningful for " +
      'a non-MISSION type, which has no single date.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsDateString()
  scheduledAt?: string | null;

  @ApiPropertyOptional({ enum: EmploymentType })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(1000000)
  amount?: number | null;

  @ApiPropertyOptional({ enum: PaymentFlow })
  @IsOptional()
  @IsEnum(PaymentFlow)
  paymentFlow?: PaymentFlow | null;

  @ApiPropertyOptional({ example: 'uuid-of-job-category', nullable: true })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(10)
  address?: string;

  @ApiPropertyOptional({ description: 'A job done from anywhere.' })
  @IsOptional()
  @IsBoolean()
  isRemote?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  quantity?: number;
}
