import { Transform } from 'class-transformer';
import {
  IsString,
  IsEmail,
  IsOptional,
  MaxLength,
  IsArray,
  IsUUID,
  ArrayMaxSize,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { HasMxRecord } from '../../../common/validators/has-mx-record.validator';
import { LocationDto } from '../../../common/dto/location.dto';

export class UpdateProfileDto extends LocationDto {
  @ApiPropertyOptional({ description: 'First name of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  @MaxLength(50)
  firstName?: string;

  @ApiPropertyOptional({ description: 'Last name of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  @MaxLength(50)
  lastName?: string;

  @ApiPropertyOptional({ description: 'Profile description / About me' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Address of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  /**
   * Editable here, unlike `phone`, which this DTO deliberately omits.
   *
   * The WhatsApp number is the login identity and changing it needs an OTP
   * round-trip, which is why it is not editable through the ordinary update
   * path. A direct line is just contact detail — nothing authenticates against
   * it — so it can change like an address can. An empty string clears it.
   */
  @ApiPropertyOptional({
    description: 'Optional second number to be reached on. Send "" to clear.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(30)
  directPhone?: string;

  /**
   * Editable here for the same reason `directPhone` is: nothing authenticates
   * against it. Email is optional at signup — most of the informal sector has
   * none — so this is how someone adds one later, or drops one that has gone
   * stale. Send `""` (or null) to clear it.
   *
   * The transform distinguishes three cases deliberately. class-transformer
   * runs it for keys that are ABSENT from the payload too, so collapsing
   * undefined into null here would make every unrelated profile edit silently
   * wipe the user's email.
   */
  @ApiPropertyOptional({
    description: 'Email address. Send "" or null to clear it.',
    nullable: true,
  })
  @Transform(({ value }) => {
    if (value === undefined) return undefined; // key absent — leave untouched
    if (typeof value !== 'string') return value ?? null; // null clears
    return value.trim().toLowerCase() || null; // "" clears
  })
  @IsOptional()
  @IsEmail()
  @HasMxRecord()
  email?: string | null;

  @ApiPropertyOptional({ description: 'Job category IDs (max 5)' })
  @Transform(({ value }) =>
    Array.isArray(value) ? value : value != null ? [value] : undefined,
  )
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(5)
  categoryIds?: string[];
}
