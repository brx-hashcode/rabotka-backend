-- CreateEnum
CREATE TYPE "PartnerApiCallKind" AS ENUM ('TOKEN', 'USERINFO', 'REVOKE', 'IDENTITY_CHECK_CREATE', 'IDENTITY_CHECK_READ');

-- CreateTable
CREATE TABLE "partner_api_requests" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "kind" "PartnerApiCallKind" NOT NULL,
    "status_code" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_api_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_partner_api_request_app_time" ON "partner_api_requests"("app_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_partner_api_request_created" ON "partner_api_requests"("created_at");

-- AddForeignKey
ALTER TABLE "partner_api_requests" ADD CONSTRAINT "partner_api_requests_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "oauth_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

