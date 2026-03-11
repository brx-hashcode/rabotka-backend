import { IsOptional, IsString, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitPaymentDto {
  @ApiPropertyOptional({ description: 'Payment reference or transaction ID' })
  @IsOptional()
  @IsString()
  paymentReference?: string;

  @ApiPropertyOptional({
    description: 'URLs of uploaded payment proof images',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  proofImages?: string[];
}
