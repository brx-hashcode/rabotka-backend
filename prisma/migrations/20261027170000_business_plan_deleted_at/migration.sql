-- A deleted plan stays for the periods and payments that point to it, hidden everywhere.
ALTER TABLE "business_plans" ADD COLUMN "deleted_at" TIMESTAMP(3);
