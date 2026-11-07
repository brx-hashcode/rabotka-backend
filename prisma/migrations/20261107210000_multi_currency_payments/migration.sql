-- Payments in every pawaPay currency: requests stay priced in XAF, and keep
-- what the network was actually charged, in its own currency, and at which rate.
ALTER TABLE "payment_requests" ADD COLUMN "charged_currency" VARCHAR(3),
ADD COLUMN "charged_amount" DECIMAL(14,2),
ADD COLUMN "fx_per_xaf" DECIMAL(24,12),
ADD COLUMN "fx_as_of" TIMESTAMPTZ;

-- The day's rate of each currency against XAF.
CREATE TABLE "exchange_rates" (
    "currency" VARCHAR(3) NOT NULL,
    "per_xaf" DECIMAL(24,12) NOT NULL,
    "source" TEXT NOT NULL,
    "as_of" TIMESTAMPTZ NOT NULL,
    "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("currency")
);
