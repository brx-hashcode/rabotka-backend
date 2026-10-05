-- KYC verification group: team members emailed when a profile is created.
ALTER TABLE "users" ADD COLUMN "kyc_reviewer" BOOLEAN NOT NULL DEFAULT false;
