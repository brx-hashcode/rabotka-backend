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
  | 'my_applications';

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
};
