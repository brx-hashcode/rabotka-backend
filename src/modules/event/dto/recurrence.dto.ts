import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecurrenceFrequency } from '@prisma/client';
import { MAX_OCCURRENCES_PER_SERIES } from '../services/recurrence-expander.service';

/**
 * Rejects a rule that sets both end conditions.
 *
 * A cross-field rule, so it cannot be expressed with `@ValidateIf` — that skips
 * a property's validation rather than failing it, which would let exactly the
 * case we are trying to catch through.
 */
@ValidatorConstraint({ name: 'exclusiveEndCondition', async: false })
export class ExclusiveEndConditionConstraint
  implements ValidatorConstraintInterface
{
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as RecurrenceDto;
    return dto.until === undefined || dto.count === undefined;
  }

  defaultMessage(): string {
    return 'A recurrence may end on a date or after a number of occurrences, not both';
  }
}

function ExclusiveEndCondition(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: ExclusiveEndConditionConstraint,
    });
  };
}

/**
 * How an event repeats.
 *
 * `until` and `count` are the two ways to end a series and are mutually
 * exclusive — a rule carrying both has two answers to "when does this stop",
 * and picking one silently is worse than a 400.
 *
 * Neither set means open-ended: generated a year out, extended as people browse
 * forward.
 */
export class RecurrenceDto {
  @ApiProperty({ enum: RecurrenceFrequency })
  @IsEnum(RecurrenceFrequency)
  frequency: RecurrenceFrequency;

  @ApiPropertyOptional({
    description:
      'ISO 8601 — inclusive last date. Mutually exclusive with count.',
  })
  @IsOptional()
  @IsDateString()
  @ExclusiveEndCondition()
  until?: string;

  @ApiPropertyOptional({
    description: `Total occurrences, counting the first. Max ${MAX_OCCURRENCES_PER_SERIES}.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_OCCURRENCES_PER_SERIES)
  count?: number;
}
