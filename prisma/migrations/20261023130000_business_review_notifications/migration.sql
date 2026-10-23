-- The business review's decisions, in the in-app feed (business accounts get
-- no WhatsApp: email and in-app only).
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_VERIFIED';
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_REJECTED';
