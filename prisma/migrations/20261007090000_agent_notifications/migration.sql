-- CreateEnum
CREATE TYPE "AgentNotificationType" AS ENUM ('COMMISSION_EARNED', 'COMMISSION_AVAILABLE', 'COMMISSION_CANCELLED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_REJECTED', 'PLACEMENT_ACCEPTED', 'PLACEMENT_STARTED', 'PLACEMENT_COMPLETED', 'PLACEMENT_ENDED', 'NEW_JOBS_IN_ZONE', 'ZONES_CHANGED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_REACTIVATED');

-- CreateTable
CREATE TABLE "agent_notifications" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_id" UUID NOT NULL,
    "type" "AgentNotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "metadata" JSONB,
    "read_at" TIMESTAMP(3),
    "dedupe_key" TEXT,

    CONSTRAINT "agent_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_push_subscriptions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "last_success_at" TIMESTAMP(3),

    CONSTRAINT "agent_push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "web_push_key_pairs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,

    CONSTRAINT "web_push_key_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_event_outbox" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "agent_event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_notifications_dedupe_key_key" ON "agent_notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "idx_agent_notif_agent_time" ON "agent_notifications"("agent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_agent_notif_agent_unread" ON "agent_notifications"("agent_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_push_subscriptions_endpoint_key" ON "agent_push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "idx_agent_push_agent" ON "agent_push_subscriptions"("agent_id");

-- CreateIndex
CREATE INDEX "idx_agent_event_outbox_pending" ON "agent_event_outbox"("processed_at", "id");

-- AddForeignKey
ALTER TABLE "agent_notifications" ADD CONSTRAINT "agent_notifications_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_push_subscriptions" ADD CONSTRAINT "agent_push_subscriptions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Agent events written by triggers, so every code path that changes a placed
-- worker's application or opens a job is covered — those writes are spread
-- over ~20 services, schedulers and the WhatsApp bot. AgentEventsConsumer
-- reads the outbox; pg_notify only wakes it (it also polls).

CREATE FUNCTION agent_outbox_placement_status() RETURNS trigger AS $$
BEGIN
  INSERT INTO agent_event_outbox (kind, entity_id, payload)
  VALUES (
    'placement_status',
    NEW.id,
    jsonb_build_object('agentId', NEW.agent_id, 'from', OLD.status, 'to', NEW.status)
  );
  PERFORM pg_notify('agent_events', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_agent_outbox
  AFTER UPDATE OF status ON applications
  FOR EACH ROW
  WHEN (NEW.agent_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION agent_outbox_placement_status();

CREATE FUNCTION agent_outbox_job_active() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'ACTIVE' AND NEW.deleted_at IS NULL AND NEW.city IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO agent_event_outbox (kind, entity_id, payload)
    VALUES (
      'job_active',
      NEW.id,
      jsonb_build_object('countryCode', NEW.country_code, 'city', NEW.city)
    );
    PERFORM pg_notify('agent_events', '');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_offers_agent_outbox
  AFTER INSERT OR UPDATE OF status ON job_offers
  FOR EACH ROW
  EXECUTE FUNCTION agent_outbox_job_active();
