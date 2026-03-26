-- AlterTable
ALTER TABLE "claim_comments" ADD COLUMN     "created_by_type" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "profile_id" UUID;

-- AddForeignKey
ALTER TABLE "claim_comments" ADD CONSTRAINT "claim_comments_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
