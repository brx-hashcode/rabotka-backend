import { SetMetadata } from '@nestjs/common';

export const OPEN_TO_BLOCKED_BUSINESS_KEY = 'openToBlockedBusiness';

/**
 * A business write a SUSPENDED or BANNED account may still make.
 * `BusinessProfileGuard` refuses every other one. Keep it to what helps put
 * the account right (its documents) or only takes something away (deleting
 * a CV, removing a member, disconnecting a mailbox).
 */
export const OpenToBlockedBusiness = () =>
  SetMetadata(OPEN_TO_BLOCKED_BUSINESS_KEY, true);
