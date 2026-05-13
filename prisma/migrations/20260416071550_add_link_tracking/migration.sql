-- CreateTable
CREATE TABLE "ad_tracked_links" (
    "id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "advertisement_id" UUID NOT NULL,
    "ad_delivery_log_id" UUID NOT NULL,
    "original_url" TEXT NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "click_count" INTEGER NOT NULL DEFAULT 0,
    "last_clicked_at" TIMESTAMP(3),
    "last_click_ip" TEXT,
    "last_click_ua" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_tracked_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_tracked_links_hash_key" ON "ad_tracked_links"("hash");

-- CreateIndex
CREATE INDEX "idx_ad_tracked_link_advertisement" ON "ad_tracked_links"("advertisement_id");

-- CreateIndex
CREATE INDEX "idx_ad_tracked_link_delivery_log" ON "ad_tracked_links"("ad_delivery_log_id");

-- AddForeignKey
ALTER TABLE "ad_tracked_links" ADD CONSTRAINT "ad_tracked_links_advertisement_id_fkey" FOREIGN KEY ("advertisement_id") REFERENCES "advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_tracked_links" ADD CONSTRAINT "ad_tracked_links_ad_delivery_log_id_fkey" FOREIGN KEY ("ad_delivery_log_id") REFERENCES "ad_delivery_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
