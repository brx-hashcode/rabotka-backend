import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

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
  @Transform(({ value }) => value !== 'false' && value !== false)
  @IsBoolean()
  includeApplications?: boolean;

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
