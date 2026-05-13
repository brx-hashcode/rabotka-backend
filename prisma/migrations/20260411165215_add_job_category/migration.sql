-- AlterTable
ALTER TABLE "job_offers" ADD COLUMN     "category_id" UUID;

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "category_id" UUID;

-- CreateTable
CREATE TABLE "job_categories" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,

    CONSTRAINT "job_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_categories_name_key" ON "job_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "job_categories_slug_key" ON "job_categories"("slug");

-- CreateIndex
CREATE INDEX "idx_job_category_slug" ON "job_categories"("slug");

-- CreateIndex
CREATE INDEX "idx_job_offer_category" ON "job_offers"("category_id");

-- CreateIndex
CREATE INDEX "idx_profile_category" ON "profiles"("category_id");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "job_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_offers" ADD CONSTRAINT "job_offers_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "job_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
