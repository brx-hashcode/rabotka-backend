import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class WhatsAppSessionDto {
  @ApiProperty({
    description:
      'One-time login code carried by a WhatsApp link (the `s` query parameter)',
    example: 'aVeryLongBase64UrlCode',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  // base64url alphabet only — anything else cannot be a code we minted, so it
  // is rejected before it ever reaches Redis.
  @Matches(/^[\w-]+$/, { message: 'Code de connexion invalide' })
  code: string;
}
