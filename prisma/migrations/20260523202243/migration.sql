-- RenameIndex
ALTER INDEX "idx_payment_request_gateway_ref" RENAME TO "payment_requests_gateway_payment_ref_key";

-- RenameIndex
ALTER INDEX "idx_penalty_application_unique" RENAME TO "penalties_application_id_key";
