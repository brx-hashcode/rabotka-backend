import { IdentityCheck, IdentityCheckStatus } from '@prisma/client';
import type { IdentityCheckResult } from './scoring/score';

export type PartnerStatus = 'pending_consent' | 'completed' | 'not_completed';

export type PartnerCheckView = {
  id: string;
  status: PartnerStatus;
  reference: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
} & Partial<IdentityCheckResult>;

const STATUS: Record<IdentityCheckStatus, PartnerStatus> = {
  PENDING_CONSENT: 'pending_consent',
  COMPLETED: 'completed',
  NOT_COMPLETED: 'not_completed',
};

export function toPartnerView(
  check: Pick<
    IdentityCheck,
    | 'id'
    | 'status'
    | 'reference'
    | 'created_at'
    | 'expires_at'
    | 'decided_at'
    | 'result'
  >,
): PartnerCheckView {
  const completed = check.status === IdentityCheckStatus.COMPLETED;

  return {
    id: check.id,
    status: STATUS[check.status],
    reference: check.reference,
    created_at: check.created_at.toISOString(),
    expires_at: check.expires_at.toISOString(),
    completed_at: completed ? (check.decided_at?.toISOString() ?? null) : null,
    ...(completed && check.result
      ? (check.result as unknown as IdentityCheckResult)
      : {}),
  };
}
