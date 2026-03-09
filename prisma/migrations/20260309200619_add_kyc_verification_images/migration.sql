-- CreateTable
CREATE TABLE "kyc_verification_images" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile_id" UUID NOT NULL,
    "image_url" TEXT NOT NULL,
    "uploaded_by" UUID,

    CONSTRAINT "kyc_verification_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_kyc_verification_image_profile" ON "kyc_verification_images"("profile_id");

-- AddForeignKey
ALTER TABLE "kyc_verification_images" ADD CONSTRAINT "kyc_verification_images_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
