-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdPaymentStatus" AS ENUM ('UNPAID', 'PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AdvertiserType" AS ENUM ('COMPANY', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "FrequencyUnit" AS ENUM ('PER_WEEK', 'PER_MONTH');

-- CreateEnum
CREATE TYPE "TargetAudience" AS ENUM ('WORKERS', 'EMPLOYERS', 'BOTH');

-- CreateEnum
CREATE TYPE "AdPriority" AS ENUM ('NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "AdDeliveryStatus" AS ENUM ('SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'FAILED');

-- CreateTable
CREATE TABLE "advertisement_bundles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "max_reach" INTEGER NOT NULL,
    "max_frequency_per_week" INTEGER NOT NULL,
    "max_duration_days" INTEGER NOT NULL,
    "allowed_channels" "DeliveryChannel"[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advertisement_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advertisements" (
    "id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "call_to_action" TEXT,
    "cta_url" TEXT,
    "image_urls" TEXT[],
    "video_url" TEXT,
    "banner_url" TEXT,
    "logo_url" TEXT,
    "contact_phone" TEXT,
    "sector" TEXT,
    "advertiser_type" "AdvertiserType" NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'fr',
    "tags" TEXT[],
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "frequency_value" INTEGER NOT NULL,
    "frequency_unit" "FrequencyUnit" NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "target_reach" INTEGER NOT NULL,
    "target_audience" "TargetAudience" NOT NULL,
    "target_filters" JSONB,
    "priority" "AdPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "AdStatus" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" TEXT,
    "payment_status" "AdPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "invoice_id" TEXT,
    "budget" DECIMAL(10,2),
    "total_sent" INTEGER NOT NULL DEFAULT 0,
    "total_opened" INTEGER NOT NULL DEFAULT 0,
    "total_clicks" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advertisements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_delivery_logs" (
    "id" UUID NOT NULL,
    "advertisement_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "status" "AdDeliveryStatus" NOT NULL,
    "sent_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "clicked_at" TIMESTAMP(3),
    "failure_reason" TEXT,

    CONSTRAINT "ad_delivery_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_advertisement_status" ON "advertisements"("status");

-- CreateIndex
CREATE INDEX "idx_advertisement_bundle" ON "advertisements"("bundle_id");

-- CreateIndex
CREATE INDEX "idx_ad_delivery_advertisement" ON "ad_delivery_logs"("advertisement_id");

-- CreateIndex
CREATE INDEX "idx_ad_delivery_profile" ON "ad_delivery_logs"("profile_id");

-- AddForeignKey
ALTER TABLE "advertisements" ADD CONSTRAINT "advertisements_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "advertisement_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_delivery_logs" ADD CONSTRAINT "ad_delivery_logs_advertisement_id_fkey" FOREIGN KEY ("advertisement_id") REFERENCES "advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_delivery_logs" ADD CONSTRAINT "ad_delivery_logs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
