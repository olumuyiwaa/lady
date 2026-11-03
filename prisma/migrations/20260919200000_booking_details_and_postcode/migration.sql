-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "addOns" JSONB,
ADD COLUMN     "homeDetails" JSONB,
ADD COLUMN     "postalCode" TEXT,
ALTER COLUMN "state" SET DEFAULT '';
