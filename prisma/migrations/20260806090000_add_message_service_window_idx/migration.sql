-- The 24h WhatsApp customer-service window is computed from a profile's most
-- recent INBOUND message, and that lookup now runs on every admin send and on
-- every render of the two admin composers. With only idx_message_profile that is
-- an index scan of the profile's entire message history plus a sort; this
-- composite turns it into a single backward index scan with LIMIT 1.
--
-- `platform` is deliberately left out: it is low-cardinality with an
-- overwhelming WHATSAPP skew, so it would widen every entry and buy no
-- selectivity.
CREATE INDEX "idx_message_profile_direction_created"
  ON "messages"("profile_id", "direction", "created_at" DESC);
