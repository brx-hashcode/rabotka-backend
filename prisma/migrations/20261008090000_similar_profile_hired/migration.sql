-- A new kind of profile notification.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'SIMILAR_PROFILE_HIRED';

-- Any application reaching ACCEPTED, agent-placed or not. Acceptance happens in
-- several code paths (the employer's accept, the contact unlock, the WhatsApp
-- bot), so it is caught here rather than at each of them. Reuses the agent
-- events outbox and its consumer (LISTEN agent_events + poll, SKIP LOCKED).
CREATE FUNCTION outbox_application_accepted() RETURNS trigger AS $$
BEGIN
  INSERT INTO agent_event_outbox (kind, entity_id, payload)
  VALUES (
    'application_accepted',
    NEW.id,
    jsonb_build_object('workerId', NEW.worker_id, 'jobOfferId', NEW.job_offer_id)
  );
  PERFORM pg_notify('agent_events', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_accepted_outbox
  AFTER UPDATE OF status ON applications
  FOR EACH ROW
  WHEN (NEW.status = 'ACCEPTED' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION outbox_application_accepted();
