import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentCallOutcome } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

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
