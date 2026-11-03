-- The Prisma schema declared these columns but no earlier migration created
-- them, so a database built from the migrations failed on first use.
-- Idempotent, so it is also safe on a database that was built with `db push`.

DO $$ BEGIN
  CREATE TYPE "SizeUnit" AS ENUM ('SQM', 'SQFT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EmploymentType" AS ENUM ('EMPLOYEE', 'ZZP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "BusinessPricing" ADD COLUMN IF NOT EXISTS "sizeUnit" "SizeUnit" NOT NULL DEFAULT 'SQM';
ALTER TABLE "CleanerProfile" ADD COLUMN IF NOT EXISTS "employmentType" "EmploymentType";
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "defaultPaymentMethodId" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "earlyStartConsentGiven" BOOLEAN NOT NULL DEFAULT false;
