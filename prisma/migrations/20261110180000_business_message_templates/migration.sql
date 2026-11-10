-- « Modèles de messages »: what a business writes once and sends again.
CREATE TYPE "BusinessMessageKind" AS ENUM ('INVITATION', 'REFUSAL', 'INFORMATION', 'OTHER');

CREATE TABLE "business_message_templates" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "business_id" UUID NOT NULL,
    "kind" "BusinessMessageKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "member_id" UUID,

    CONSTRAINT "business_message_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_business_message_template_business_kind" ON "business_message_templates"("business_id", "kind");

ALTER TABLE "business_message_templates" ADD CONSTRAINT "business_message_templates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_message_templates" ADD CONSTRAINT "business_message_templates_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "business_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
