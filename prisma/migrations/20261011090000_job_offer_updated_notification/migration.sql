-- AlterEnum
--
-- An employer can now edit an ACTIVE offer. When the pay, date or place
-- changes, every candidate still on it is told in the bell.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'JOB_OFFER_UPDATED';
