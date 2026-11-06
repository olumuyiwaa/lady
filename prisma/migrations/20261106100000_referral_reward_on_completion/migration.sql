-- AlterTable
ALTER TABLE "BusinessPricing" ADD COLUMN "referralHoldDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "referralRewardCents" INTEGER;

-- One reward per referred booking (NULLs stay allowed for ordinary coupons).
DROP INDEX IF EXISTS "Coupon_sourceBookingId_idx";
CREATE UNIQUE INDEX "Coupon_sourceBookingId_key" ON "Coupon"("sourceBookingId");
