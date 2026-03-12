import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSystemConfigDto {
  @ApiProperty({
    description:
      'New value (always stored as a string; booleans as "true"/"false", numbers as their string representation)',
    example: '5000',
  })
  @IsString()
  value: string;
}
