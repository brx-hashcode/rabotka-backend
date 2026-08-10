import type { VerificationStatus } from '@prisma/client';

export type BotState = {
  flowId: string;
  step: number;
  payload: Record<string, unknown>;
  updatedAt: string;
};

export type FlowId =
  | 'publish_job'
  | 'apply_job'
  | 'cancel_application'
  | 'accept_refuse_candidate'
  | 'candidatures_list'
  | 'list_offers'
  | 'my_applications'
  | 'my_offers';

export type BotProfileType = 'WORKER' | 'EMPLOYER';

export type BotProfile = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  profile_type: BotProfileType;
  status: string;
  reliability_score: number | null;
  address?: string;
  description?: string;
  /**
   * KYC state. Optional because the orchestrator's own KYC gate only runs while
   * `whatsapp_connected` is false — once a user has verified their number they
   * reach every flow, so flows that spend money must check this themselves.
   */
  verification_status?: VerificationStatus;
};
