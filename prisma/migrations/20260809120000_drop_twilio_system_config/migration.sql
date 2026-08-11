-- WhatsApp credentials are environment-only from here on, for both the Twilio
-- and the Meta Cloud provider (see src/modules/whatsapp/whatsapp.config.ts).
--
-- These rows were readable by TwilioService at boot and writable from the admin
-- settings card, so the process could be sending on credentials that appeared
-- nowhere in its configuration. Removing them from DEFAULT_SYSTEM_CONFIGS is
-- not enough on its own: seedDefaults() upserts by key and never deletes, so
-- the rows would survive as orphans the admin UI could still write to.
--
-- PREREQUISITE: the values must already be in the deployment's environment.
-- Run `node_modules/.bin/tsx scripts/dump-twilio-config.ts` BEFORE deploying.
--
-- ConfigCategory.TWILIO is deliberately left in the enum — it becomes unused,
-- and dropping a Postgres enum value is a destructive migration for no gain.
DELETE FROM "system_configs"
WHERE "key" IN (
  'twilio.account_sid',
  'twilio.auth_token',
  'twilio.whatsapp_from',
  'twilio.sms_from'
);
