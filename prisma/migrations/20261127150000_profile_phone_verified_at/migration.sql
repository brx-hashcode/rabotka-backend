-- When the profile's current phone number was proven by a WhatsApp code.
-- OIDC's phone_number_verified reads it (security audit run 2): it was
-- always true, even for a business account that had proven only an e-mail.
ALTER TABLE "profiles" ADD COLUMN "phone_verified_at" TIMESTAMP(3);

-- Every non-business account signed up by a WhatsApp code to its number.
-- Business accounts did not prove theirs before the WhatsApp check at
-- business sign-up: they stay unproven until their number is confirmed.
UPDATE "profiles"
SET "phone_verified_at" = "created_at"
WHERE "is_business" = false;
