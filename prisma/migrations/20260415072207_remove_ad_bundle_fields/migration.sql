/*
  Warnings:

  - You are about to drop the column `channel` on the `advertisements` table. All the data in the column will be lost.
  - You are about to drop the column `frequency_unit` on the `advertisements` table. All the data in the column will be lost.
  - You are about to drop the column `frequency_value` on the `advertisements` table. All the data in the column will be lost.
  - You are about to drop the column `priority` on the `advertisements` table. All the data in the column will be lost.
  - You are about to drop the column `target_audience` on the `advertisements` table. All the data in the column will be lost.
  - You are about to drop the column `target_reach` on the `advertisements` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "advertisements" DROP COLUMN "channel",
DROP COLUMN "frequency_unit",
DROP COLUMN "frequency_value",
DROP COLUMN "priority",
DROP COLUMN "target_audience",
DROP COLUMN "target_reach";

-- DropEnum
DROP TYPE "AdPriority";

-- DropEnum
DROP TYPE "FrequencyUnit";

-- DropEnum
DROP TYPE "TargetAudience";
