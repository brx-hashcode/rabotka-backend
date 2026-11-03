-- An organisation that works online only has no address: the country stays
-- required (CEMAC + RDC), the address and the city become optional.

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "address" DROP NOT NULL;
