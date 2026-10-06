import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentCallOutcome, AgentMomoOperator } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class AgentLogCallDto {
  @ApiProperty({ enum: AgentCallOutcome })
  @IsEnum(AgentCallOutcome, { message: "Résultat d'appel invalide" })
  outcome: AgentCallOutcome;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AgentRequestWithdrawalDto {
  @ApiProperty({ description: 'FCFA, whole number', example: 2000 })
  @IsInt({ message: 'Le montant doit être un nombre entier' })
  @Min(1)
  amount: number;

  @ApiProperty({ enum: AgentMomoOperator })
  @IsEnum(AgentMomoOperator, { message: 'Opérateur Mobile Money invalide' })
  momoOperator: AgentMomoOperator;

  @ApiPropertyOptional({
    description: "Number to pay; defaults to the agent's own phone",
    example: '+242061234567',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  momoPhone?: string;
}

export class AgentWorkerPhoneDto {
  @ApiProperty({
    description: "The worker's WhatsApp number, with its country code",
    example: '+242061234567',
  })
  @IsString()
  @MaxLength(32)
  phone: string;
}
