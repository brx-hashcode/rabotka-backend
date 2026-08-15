import { IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EventEditScope } from '../enums/event-edit-scope.enum';

export class DeleteEventQueryDto {
  /**
   * A query param here, unlike the update's body-borne scope: DELETE carries no
   * body in the admin's HTTP client.
   *
   * Absent means THIS, so an existing caller keeps deleting exactly one row.
   */
  @ApiPropertyOptional({ enum: EventEditScope, default: EventEditScope.THIS })
  @IsOptional()
  @IsEnum(EventEditScope)
  scope?: EventEditScope;
}
