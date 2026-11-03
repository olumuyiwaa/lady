-- Custom booking questions: per-business questions on the booking form, and
-- the answers snapshot stored on each booking.
-- Hand-written to match `prisma migrate diff` output. Confirm there is no drift with:
--   git show <commit before this one>:prisma/schema.prisma > /tmp/before.prisma
--   npx prisma migrate diff --from-schema-datamodel /tmp/before.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script
-- The output should equal this file's statements.

-- CreateEnum
CREATE TYPE "BookingQuestionType" AS ENUM ('TEXT', 'LONG_TEXT', 'SELECT', 'MULTI_SELECT', 'YES_NO', 'NUMBER');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "customAnswers" JSONB;

-- CreateTable
CREATE TABLE "BookingQuestion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "type" "BookingQuestionType" NOT NULL DEFAULT 'TEXT',
    "options" TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "serviceIds" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingQuestion_businessId_isActive_sortOrder_idx" ON "BookingQuestion"("businessId", "isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "BookingQuestion" ADD CONSTRAINT "BookingQuestion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
