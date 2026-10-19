-- CreateTable
CREATE TABLE "profile_push_subscriptions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "last_success_at" TIMESTAMP(3),

    CONSTRAINT "profile_push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profile_push_subscriptions_endpoint_key" ON "profile_push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "idx_profile_push_profile" ON "profile_push_subscriptions"("profile_id");

-- AddForeignKey
ALTER TABLE "profile_push_subscriptions" ADD CONSTRAINT "profile_push_subscriptions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
