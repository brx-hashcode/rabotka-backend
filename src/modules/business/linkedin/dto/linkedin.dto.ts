import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @IsOptional()
  @IsBoolean()
  again?: boolean;
}
