import { PickType } from '@nestjs/swagger';
import { CreateClaimDto } from './create-claim.dto';

/**
 * What a profile may set on its own claim: its words and its attachments.
 *
 * The profile route used to take `CreateClaimDto`, which also carries the
 * staff-only `assigned_user_id` and `profile_id` — so a complainant could
 * pick which staff member got their claim (pentest A2-F16, #872). With these
 * fields absent, `forbidNonWhitelisted` refuses them outright.
 */
export class ProfileCreateClaimDto extends PickType(CreateClaimDto, [
  'title',
  'description',
  'attachment_urls',
] as const) {}
