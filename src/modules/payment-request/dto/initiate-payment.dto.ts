import {
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InitiatePaymentDto {
  @ApiProperty({ example: '069917686' })
  @IsString()
  @MinLength(7)
  @MaxLength(15)
  @Matches(/^\+?\d+$/, { message: 'phone must contain only digits' })
  phone!: string;

  @ApiPropertyOptional({
    description:
      'Mobile-money operator code. Required by gateways that route by network, omitted by gateways that serve a single one — see GET /payment-requests/gateways.',
    example: 'MTN_MOMO_COG',
  })
  // The format only. WHICH codes are valid is the gateway's live
  // configuration (networks are enabled on pawaPay, not in code), checked by
  // the service against it. A fixed list here refused every network it did
  // not name — Gabon, Bénin, Côte d'Ivoire, Sénégal — before that check ran.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9_]{2,40}$/, { message: 'operator must be a network code' })
  operator?: string;
}
