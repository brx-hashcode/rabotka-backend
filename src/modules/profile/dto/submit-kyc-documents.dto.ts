import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { DocumentType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A value that is missing, null or blank counts as not sent. */
const blankToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : (value ?? undefined);

/**
 * Identity documents sent by a signed-in person (`POST /profile/me/kyc`), each
 * file pre-uploaded through `POST /profile/me/kyc-upload`. The same fields as
 * the sign-up's, but the whole set is required: there is no « later » here.
 * Unlike the sign-up, the back is required for every type but PASSPORT — no
 * deployed client predates this route.
 */
export class SubmitKycDocumentsDto {
  @ApiProperty({ enum: DocumentType, example: DocumentType.IDENTITY_CARD })
  @Transform(blankToUndefined)
  @IsEnum(DocumentType)
  documentType!: DocumentType;

  @ApiProperty({
    description: 'Front of the identity document (its upload url).',
  })
  @Transform(blankToUndefined)
  @IsString()
  @IsNotEmpty({ message: "Le document d'identité est requis." })
  kycDocumentUrl!: string;

  @ApiPropertyOptional({ description: 'Storage key returned by the upload.' })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  kycDocumentKey?: string;

  @ApiPropertyOptional({
    description: 'Back of the document: required for every type but PASSPORT.',
  })
  @Transform(blankToUndefined)
  @ValidateIf(
    (o: SubmitKycDocumentsDto) => o.documentType !== DocumentType.PASSPORT,
  )
  @IsString()
  @IsNotEmpty({ message: "Le verso du document d'identité est requis." })
  kycDocumentBackUrl?: string;

  @ApiPropertyOptional({ description: 'Storage key returned by the upload.' })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  kycDocumentBackKey?: string;

  @ApiProperty({ description: 'The selfie (its upload url).' })
  @Transform(blankToUndefined)
  @IsString()
  @IsNotEmpty({ message: 'Le selfie est requis.' })
  kycSelfieUrl!: string;

  @ApiPropertyOptional({ description: 'Storage key returned by the upload.' })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  kycSelfieKey?: string;
}
