-- CreateTable
CREATE TABLE "claim_comments" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "claim_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "user_id" UUID,

    CONSTRAINT "claim_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "claim_comments_claim_id_idx" ON "claim_comments"("claim_id");

-- AddForeignKey
ALTER TABLE "claim_comments" ADD CONSTRAINT "claim_comments_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_comments" ADD CONSTRAINT "claim_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
