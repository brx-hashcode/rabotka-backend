import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

export enum VerifyDecision {
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

/**
 * One supporting image the admin attached, already uploaded.
 *
 * This route used to take the bytes themselves, as up to ten binary parts of
 * the verify request. They go to `POST admin/profiles/:id/verification-images`
 * one at a time now, as the admin picks them, and only the descriptors arrive
 * here.
 */
export class AdminVerifyDocumentDto {
  @ApiProperty({
    description:
      'Storage key returned by POST admin/profiles/:id/verification-images. ' +
      'Must name an object under this profile’s own kyc-verification folder.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  key: string;

  @ApiPropertyOptional({
    description:
      'The signed preview url that came back beside the key. Optional, never ' +
      'stored, and read only to re-derive the key if `key` itself is unusable.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;
}

export class AdminVerifyProfileDto {
  @ApiProperty({
    description: 'Verification decision',
    enum: VerifyDecision,
  })
  @IsEnum(VerifyDecision)
  decision: VerifyDecision;

  @ApiProperty({
    description:
      'Admin decision note (required for both approve and reject; stored on the profile)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'La raison / la note est requise' })
  reason: string;

  /**
   * `@Type` is not decoration here, it is load-bearing. Without it
   * class-transformer leaves these as plain objects, `@ValidateNested` finds no
   * metadata to check them against, and the global `forbidNonWhitelisted`
   * rejects the whole payload.
   *
   * That same flag means a caller must send EXACTLY `{ key, url }` per item —
   * an extra `name` or `size` is a 400 for the entire request. It is also what
   * makes a version mismatch loud: an admin bundle sending `documents` to a
   * deployment that predates this field gets a 400 rather than silently having
   * every attached image dropped.
   *
   * `ArrayMaxSize(10)` carries over the cap the old `FilesInterceptor('files', 10)`
   * enforced.
   */
  @ApiPropertyOptional({
    type: [AdminVerifyDocumentDto],
    maxItems: 10,
    description: 'Supporting images, pre-uploaded. Optional.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AdminVerifyDocumentDto)
  documents?: AdminVerifyDocumentDto[];
}
