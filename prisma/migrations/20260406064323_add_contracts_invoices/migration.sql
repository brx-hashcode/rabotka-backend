-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING_DOWNLOAD', 'DOWNLOADED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING_DOWNLOAD', 'DOWNLOADED');

-- CreateEnum
CREATE TYPE "InvoiceReason" AS ENUM ('CONTACT_UNLOCK', 'PENALTY', 'OTHER');

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "application_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 1,
    "status" "ContractStatus" NOT NULL DEFAULT 'PENDING_DOWNLOAD',

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "profile_id" UUID NOT NULL,
    "payment_request_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" "InvoiceReason" NOT NULL DEFAULT 'OTHER',
    "related_entity_type" TEXT,
    "related_entity_id" UUID,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING_DOWNLOAD',

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contracts_application_id_key" ON "contracts"("application_id");

-- CreateIndex
CREATE INDEX "idx_contract_application" ON "contracts"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_payment_request_id_key" ON "invoices"("payment_request_id");

-- CreateIndex
CREATE INDEX "idx_invoice_profile" ON "invoices"("profile_id");

-- CreateIndex
CREATE INDEX "idx_invoice_payment_request" ON "invoices"("payment_request_id");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_request_id_fkey" FOREIGN KEY ("payment_request_id") REFERENCES "payment_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
