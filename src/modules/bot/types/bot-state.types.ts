/**
 * Bot conversation state stored in Redis.
 * When flowId is set, the next message is routed to the corresponding flow.
 */
export type BotState = {
  flowId: string;
  step: number;
  payload: Record<string, unknown>;
  updatedAt: string; // ISO date
};

/**
 * Flow identifiers (must match bot.constants.ts FLOW_IDS)
 */
export type FlowId =
  | 'publish_job'
  | 'apply_job'
  | 'cancel_application'
  | 'accept_refuse_candidate'
  | 'list_offers'
  | 'my_applications';

/**
 * Profile type for routing (Worker vs Employer menu)
 */
export type BotProfileType = 'WORKER' | 'EMPLOYER';

/**
 * Minimal profile shape used by bot commands and flows
 */
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
