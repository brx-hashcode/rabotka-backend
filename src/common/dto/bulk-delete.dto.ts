import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Shared body for admin bulk soft-delete endpoints
 * (`POST /admin/<resource>/bulk-delete`). Rows are archived (deleted_at set),
 * not removed. Capped to keep a single request bounded.
 */
export class BulkDeleteDto {
  @ApiProperty({ type: [String], description: 'IDs of the rows to archive' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids!: string[];
}
