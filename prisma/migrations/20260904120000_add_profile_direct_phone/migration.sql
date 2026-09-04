-- A second number the person can be reached on, when the WhatsApp number is
-- not one they answer calls on.
--
-- Nullable and NOT unique, unlike "phone". Nothing authenticates against this
-- column and no OTP is sent to it, so a household handset or a company
-- switchboard shared by two profiles must not make the second signup fail.
ALTER TABLE "profiles" ADD COLUMN "direct_phone" TEXT;
