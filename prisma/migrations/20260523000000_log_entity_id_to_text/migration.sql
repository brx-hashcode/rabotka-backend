-- Widen logs.entity_id from UUID to TEXT so non-UUID identifiers
-- (e.g. system_config keys like "twilio.auth_token", integer event ids)
-- can be stored. The UUID constraint was too strict for a polymorphic
-- audit-log table.

ALTER TABLE "logs" ALTER COLUMN "entity_id" TYPE TEXT;
