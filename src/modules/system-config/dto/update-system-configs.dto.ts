import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * A batch of config writes applied as one unit.
 *
 * The shape stays `Record<string, string>` — same storage contract as the
 * single-key PATCH — because the keys are data, not a schema: they are seeded
 * from `DEFAULT_SYSTEM_CONFIGS` and a DTO enumerating them would be a third
 * copy of that list to keep in step.
 *
 * So this validates only that the body is a flat string map; what the values
 * are allowed to BE is decided in `SystemConfigService.setMany`, which is the
 * only place that can see the whole resulting state — the parrainage rules
 * (unit follows commission type, percentages sum to at most 100) span several
 * keys and are unanswerable one field at a time.
 */
export class UpdateSystemConfigsDto {
  @ApiProperty({
    description:
      'Map of config key → new value. Values are always strings; booleans as "true"/"false", numbers as their string representation. Applied in a single transaction.',
    example: {
      'fees.referral_commission_type': 'PERCENTAGE',
      'fees.referral_credit_referrer': '60',
      'fees.referral_credit_referee': '40',
    },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  values: Record<string, string>;
}
