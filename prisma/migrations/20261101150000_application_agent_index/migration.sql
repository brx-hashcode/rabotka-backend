-- An agent's jobs are read through their placements, on every history page.
CREATE INDEX "idx_application_agent" ON "applications"("agent_id");
