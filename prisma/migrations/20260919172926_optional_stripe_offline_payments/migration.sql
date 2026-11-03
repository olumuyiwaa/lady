-- CreateEnum
CREATE TYPE "PreferredPaymentCollection" AS ENUM ('ONLINE_CARD', 'MANUAL_OFFLINE', 'BOTH');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "offlinePaymentInstructions" TEXT,
ADD COLUMN     "preferredPaymentCollection" "PreferredPaymentCollection" NOT NULL DEFAULT 'BOTH';
