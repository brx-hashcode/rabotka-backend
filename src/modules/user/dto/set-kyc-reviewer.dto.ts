import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetKycReviewerDto {
  @ApiProperty({
    description:
      'True adds the member to the KYC verification group (emailed on each new profile), false removes them',
    example: true,
  })
  @IsBoolean()
  enabled: boolean;
}
