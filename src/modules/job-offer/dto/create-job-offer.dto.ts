import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsInt,
  IsEnum,
  IsOptional,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { PaymentFlow } from '@prisma/client';

export class CreateJobOfferDto {
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

  @ApiProperty({ example: '2026-02-15T09:00:00.000Z' })
  @IsString()
  scheduled_at!: string;

  @ApiPropertyOptional({
    example: 15000,
    description: 'Amount in FCFA (0 or omitted = not specified)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'Le montant minimum est 0 FCFA' })
  @Max(1_000_000, { message: 'Le montant maximum est 1 000 000 FCFA' })
  amount?: number;

  @ApiPropertyOptional({ enum: PaymentFlow })
  @IsOptional()
  @IsEnum(PaymentFlow)
  payment_flow?: PaymentFlow | null;

  @ApiProperty({
    example: '123 Avenue de la Paix, Poto-Poto, Brazzaville',
  })
  @IsString()
  @MinLength(10)
  address!: string;

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
