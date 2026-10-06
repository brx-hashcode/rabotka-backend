-- Field agents: an agent may cancel their own open withdrawal.
--
-- Enum additions only. The partial unique index `agent_withdrawals_one_open`
-- (status = 'REQUESTED') is untouched.

-- AlterEnum
ALTER TYPE "AgentWithdrawalStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "AgentLedgerKind" ADD VALUE 'WITHDRAWAL_CANCELLED';
