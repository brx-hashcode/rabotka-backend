-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "portfolio_slug" TEXT;

-- CreateTable
CREATE TABLE "portfolio_items" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "profile_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "portfolio_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_images" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "portfolio_item_id" UUID NOT NULL,
    "image_url" TEXT NOT NULL,
    "storage_key" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "portfolio_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_portfolio_item_profile" ON "portfolio_items"("profile_id");

-- CreateIndex
CREATE INDEX "idx_portfolio_image_item" ON "portfolio_images"("portfolio_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_portfolio_slug_key" ON "profiles"("portfolio_slug");

-- AddForeignKey
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_images" ADD CONSTRAINT "portfolio_images_portfolio_item_id_fkey" FOREIGN KEY ("portfolio_item_id") REFERENCES "portfolio_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

