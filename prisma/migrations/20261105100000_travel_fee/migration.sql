-- Dynamic travel fee: per-business settings and what each booking was charged.
ALTER TABLE "BusinessPricing" ADD COLUMN "travelFreeKm" INTEGER,
ADD COLUMN "travelFeePerKmCents" INTEGER,
ADD COLUMN "travelFeeMaxCents" INTEGER;

ALTER TABLE "Booking" ADD COLUMN "travelFeeCents" INTEGER,
ADD COLUMN "travelDistanceMeters" INTEGER;
