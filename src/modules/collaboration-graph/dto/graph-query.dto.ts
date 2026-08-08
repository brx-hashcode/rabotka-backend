import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ToBoolean } from '../../../common/utils/query-boolean.util';

export class GraphQueryDto {
  @ApiPropertyOptional({
    description:
      'Drop links with fewer than this many real collaborations. 0 keeps applied-but-never-worked links.',
    default: 0,
  })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  minCollaborations?: number;

  @ApiPropertyOptional({
    description: 'Include the faint applied-but-never-worked links.',
    default: true,
  })
  @IsOptional()
  @ToBoolean(true)
  @IsBoolean()
  includeApplications?: boolean;

  @ApiPropertyOptional({
    description:
      'Include links where the employer only paid to unlock a contact.',
    default: true,
  })
  @IsOptional()
  @ToBoolean(true)
  @IsBoolean()
  includeContacts?: boolean;

  @ApiPropertyOptional({
    description: 'Max links returned; the strongest are kept.',
    default: 2000,
  })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number;
}
