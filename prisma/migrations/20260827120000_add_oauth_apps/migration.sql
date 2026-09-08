-- CreateEnum
CREATE TYPE "OAuthAppStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "oauth_apps" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "logo_url" TEXT,
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT NOT NULL,
    "client_secret_hint" TEXT NOT NULL,
    "previous_secret_hash" TEXT,
    "previous_secret_expires_at" TIMESTAMP(3),
    "secret_rotated_at" TIMESTAMP(3),
    "redirect_uris" TEXT[],
    "allowed_scopes" TEXT[],
    "status" "OAuthAppStatus" NOT NULL DEFAULT 'ACTIVE',
    "contact_email" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "oauth_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorizations" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "pairwise_sub" TEXT NOT NULL,
    "scopes" TEXT[],
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_apps_client_id_key" ON "oauth_apps"("client_id");

-- CreateIndex
CREATE INDEX "idx_oauth_app_client_id" ON "oauth_apps"("client_id");

-- CreateIndex
CREATE INDEX "idx_oauth_app_status" ON "oauth_apps"("status");

-- CreateIndex
CREATE INDEX "idx_oauth_app_deleted_at" ON "oauth_apps"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorizations_pairwise_sub_key" ON "oauth_authorizations"("pairwise_sub");

-- CreateIndex
CREATE INDEX "idx_oauth_authorization_profile" ON "oauth_authorizations"("profile_id");

-- CreateIndex
CREATE INDEX "idx_oauth_authorization_app_revoked" ON "oauth_authorizations"("app_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorizations_app_id_profile_id_key" ON "oauth_authorizations"("app_id", "profile_id");

-- AddForeignKey
ALTER TABLE "oauth_apps" ADD CONSTRAINT "oauth_apps_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "oauth_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

