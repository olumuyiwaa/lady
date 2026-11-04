-- Customer portal: preferred cleaner and referral reward ownership.
ALTER TABLE "Customer" ADD COLUMN "preferredCleanerId" TEXT;
ALTER TABLE "Coupon" ADD COLUMN "ownerCustomerId" TEXT;
CREATE INDEX "Coupon_ownerCustomerId_idx" ON "Coupon"("ownerCustomerId");
