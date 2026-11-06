import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class LinkedinPostDto {
  @ApiProperty({ description: 'The offer to post' })
  @IsUUID()
  offerId!: string;

  @ApiProperty({
    description:
      'The text above the offer card (LinkedIn allows 3,000 characters)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(3000)
  text!: string;

  @ApiPropertyOptional({
    description: 'Post it again although it was already posted (after an edit)',
  })
  // A multipart field when a picture comes with it: « true » as text.
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  again?: boolean;

  @ApiPropertyOptional({
    description:
      'Posting again without a picture: use the offer’s share image rather than the previous post’s own picture',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  offerImage?: boolean;
}
