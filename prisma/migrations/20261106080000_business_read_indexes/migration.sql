-- Indexes for what the business space reads most: a candidate's opinions,
-- an offer's careers applications by status.

-- CreateIndex
CREATE INDEX "idx_candidate_opinion_application" ON "candidate_opinions"("application_id");

-- CreateIndex
CREATE INDEX "idx_candidate_opinion_external" ON "candidate_opinions"("external_application_id");

-- CreateIndex
CREATE INDEX "idx_external_application_offer_status" ON "external_applications"("job_offer_id", "status");

