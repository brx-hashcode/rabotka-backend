-- An admin assigning a plan, or ending one, tells the business in-app.
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_SUBSCRIPTION_GRANTED';
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_SUBSCRIPTION_CANCELLED';
