-- CreateEnum
CREATE TYPE "WalletOwnerType" AS ENUM ('SYSTEM', 'USER', 'PROFILE');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('CREDIT_PENALTY', 'CREDIT_COMMISSION');

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "owner_type" "WalletOwnerType" NOT NULL,
    "user_id" UUID,
    "profile_id" UUID,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reference_type" TEXT,
    "reference_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_wallet_owner_type" ON "wallets"("owner_type");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_owner_type_user_id_key" ON "wallets"("owner_type", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_owner_type_profile_id_key" ON "wallets"("owner_type", "profile_id");

-- CreateIndex
CREATE INDEX "idx_wallet_transaction_wallet" ON "wallet_transactions"("wallet_id");

-- CreateIndex
CREATE INDEX "idx_wallet_transaction_created_at" ON "wallet_transactions"("created_at");

-- CreateIndex
CREATE INDEX "idx_wallet_transaction_type" ON "wallet_transactions"("type");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
