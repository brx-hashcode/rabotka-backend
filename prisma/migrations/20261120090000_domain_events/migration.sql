-- Domain events: a transactional outbox. A row is written in the same
-- transaction as the change it describes, so it exists if and only if that
-- change committed. DomainEventRelay hands each row to every consumer that
-- subscribed to its type (one BullMQ queue per consumer), then stamps
-- relayed_at. Relayed rows are kept 30 days so a consumer can be replayed.
-- See hashcode/docs/rabotka-backend/architecture/domain-events.md.

-- CreateTable
CREATE TABLE "domain_events" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "relayed_at" TIMESTAMPTZ,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_domain_events_pending" ON "domain_events"("relayed_at", "id");

-- CreateIndex
CREATE INDEX "idx_domain_events_aggregate" ON "domain_events"("aggregate_type", "aggregate_id");

-- Wake the relay. The notification is delivered at commit, and only then;
-- the relay also polls, so a missed one only delays delivery.
CREATE FUNCTION domain_events_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('domain_events', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER domain_events_notify
  AFTER INSERT ON "domain_events"
  FOR EACH STATEMENT EXECUTE FUNCTION domain_events_notify();
