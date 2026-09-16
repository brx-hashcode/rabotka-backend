import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * The body of `POST /identity-checks`.
 *
 * snake_case, like the rest of the partner-facing OIDC surface, rather than
 * the camelCase used by Rabotka's own apps.
 */
export class CreateIdentityCheckDto {
  @ApiProperty({
    example: '+242061234567',
    description:
      'The WhatsApp number, with its country code. `00242…` is accepted; a ' +
      'number without a country code is refused.',
  })
  @IsString()
  @Length(8, 24)
  phone!: string;

  @ApiProperty({ example: 'Jean' })
  @IsString()
  @Length(1, 80)
  first_name!: string;

  @ApiProperty({ example: 'Mabiala' })
  @IsString()
  @Length(1, 80)
  last_name!: string;

  @ApiPropertyOptional({ example: 'CG', description: 'ISO 3166-1 alpha-2.' })
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'country_code must be an ISO 3166-1 alpha-2 code',
  })
  country_code?: string;

  @ApiPropertyOptional({ example: 'Brazzaville' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ enum: DocumentType })
  @IsOptional()
  @IsEnum(DocumentType)
  document_type?: DocumentType;

  @ApiPropertyOptional({
    example: 'loan-application-4821',
    description: 'Your own identifier, echoed back in every response.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;
}
