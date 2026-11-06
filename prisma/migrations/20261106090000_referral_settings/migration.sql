-- AlterTable
ALTER TABLE "BusinessPricing" ADD COLUMN "referralEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "referralDiscountCents" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN "referralRewardCents" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN "referralRewardValidDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN "referralMinBookingCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "referralDiscountCents" INTEGER;

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN "sourceBookingId" TEXT;

-- CreateIndex
CREATE INDEX "Coupon_sourceBookingId_idx" ON "Coupon"("sourceBookingId");
