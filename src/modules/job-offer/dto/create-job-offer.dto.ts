import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsInt,
  IsEnum,
  IsOptional,
  IsDateString,
  IsBoolean,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { EmploymentType, PaymentFlow } from '@prisma/client';
import { LocationDto } from '../../../common/dto/location.dto';

export class CreateJobOfferDto extends LocationDto {
  @ApiProperty({ example: 'Plombier pour réparation urgente' })
  @IsString()
  @MinLength(5, { message: 'Le titre doit contenir entre 5 et 100 caractères' })
  @MaxLength(100)
  title!: string;

  @ApiProperty({
    example:
      "Réparation fuite d'eau cuisine, remplacement robinet, vérification tuyauterie",
  })
  @IsString()
  @MinLength(20, {
    message: 'La description doit contenir entre 20 et 1000 caractères',
  })
  @MaxLength(1000)
  description!: string;

  @ApiPropertyOptional({
    enum: EmploymentType,
    default: EmploymentType.MISSION,
    description:
      'What kind of engagement this is. MISSION (the default) is a one-off gig ' +
      'and is the only type that requires a closing date.',
  })
  @IsOptional()
  @IsEnum(EmploymentType)
  employment_type?: EmploymentType;

  @ApiPropertyOptional({
    example: '2026-02-15T09:00:00.000Z',
    description:
      'When the offer CLOSES to applications. Required for a MISSION; may be ' +
      'omitted for CDI/CDD/STAGE, which have no single date. Enforced in the ' +
      'service, which is the only place that knows both fields.',
  })
  @IsOptional()
  @IsDateString()
  scheduled_at?: string;

  @ApiPropertyOptional({
    example: 15000,
    description: 'Amount in FCFA (0 or omitted = not specified)',
  })
  @IsOptional()
  @IsNumber()
  @Min(1_000, { message: 'Le montant minimum est 1 000 FCFA' })
  @Max(1_000_000, { message: 'Le montant maximum est 1 000 000 FCFA' })
  amount?: number;

  @ApiPropertyOptional({ enum: PaymentFlow })
  @IsOptional()
  @IsEnum(PaymentFlow)
  payment_flow?: PaymentFlow | null;

  @ApiPropertyOptional({
    example: '123 Avenue de la Paix, Poto-Poto, Brazzaville',
    description:
      'Required unless isRemote is true — a remote job has no site. ' +
      'Enforced in the service, which is the only place that knows both fields.',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  address?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'A job done from anywhere. Clears address, country and city.',
  })
  @IsOptional()
  @IsBoolean()
  isRemote?: boolean;

  @ApiPropertyOptional({ example: 'Apporter vos propres outils' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    example: 'cuid-of-job-category',
    description: 'Optional job category',
  })
  @IsOptional()
  @IsString()
  category_id?: string;

  @ApiProperty({ example: 2, description: 'Number of persons needed' })
  @IsInt()
  @Min(1, { message: 'Au moins 1 personne requise' })
  @Max(100, { message: 'Maximum 100 personnes' })
  quantity!: number;
}
