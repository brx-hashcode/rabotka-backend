-- A person can sign up without their identity documents and send them later
-- from the app. Until then there is nothing to review: NOT_SUBMITTED, kept
-- apart from PENDING (documents waiting for a reviewer). No row changes.
ALTER TYPE "VerificationStatus" ADD VALUE IF NOT EXISTS 'NOT_SUBMITTED';
