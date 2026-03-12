-- CreateEnum
CREATE TYPE "ConfigCategory" AS ENUM ('TWILIO', 'FEES', 'MATCHING', 'CONTACT', 'STORAGE', 'GENERAL');

-- CreateTable
CREATE TABLE "system_configs" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" "ConfigCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "system_configs_key_key" ON "system_configs"("key");

-- CreateIndex
CREATE INDEX "idx_system_config_category" ON "system_configs"("category");
