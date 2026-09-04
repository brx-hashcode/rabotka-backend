import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Step 1 of changing the WhatsApp number: name the new one.
 *
 * Nothing is written yet. The number is the login identity — every login link
 * and notification goes to it — so it only moves once the person has proved
 * they hold the new handset, in {@link ConfirmPhoneChangeDto}. Committing on
 * this request would mean a single typo sends every future login to a number
 * the user does not own, with no way back that does not involve support.
 */
export class RequestPhoneChangeDto {
  @ApiProperty({
    description: 'The new WhatsApp number, in international format',
    example: '+242060000000',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.replaceAll(/[\s.-]/g, '') : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  // Same shape AuthService.isPhone accepts, so a number that passes here is one
  // the login path can later find.
  @Matches(/^\+?\d{8,15}$/, {
    message: 'Numéro de téléphone invalide',
  })
  newPhone: string;
}

/** Step 2: the code we sent to the new number. */
export class ConfirmPhoneChangeDto {
  @ApiProperty({ description: 'The 6-digit code sent to the new number' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'Code invalide' })
  code: string;
}
