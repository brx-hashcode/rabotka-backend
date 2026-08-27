import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ClaimStatus } from '@prisma/client';

export class ReorderClaimDto {
  @ApiProperty({ enum: ClaimStatus, description: 'Column the claim lands in' })
  @IsEnum(ClaimStatus)
  status: ClaimStatus;

  @ApiProperty({
    description:
      'Slot the claim should occupy in that column once it has landed, ' +
      'counting the claim itself. Clamped to the column length server-side.',
    minimum: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  index: number;
}
