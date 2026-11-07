-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('VACATION', 'SICK', 'PERSONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "language" TEXT,
ADD COLUMN "whatsappOptInAt" TIMESTAMP(3),
ADD COLUMN "whatsappOptOutAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CleanerLeave" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cleanerId" TEXT NOT NULL,
    "type" "LeaveType" NOT NULL DEFAULT 'VACATION',
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "decisionNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CleanerLeave_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CleanerLeave_businessId_status_idx" ON "CleanerLeave"("businessId", "status");

-- CreateIndex
CREATE INDEX "CleanerLeave_cleanerId_status_startsAt_idx" ON "CleanerLeave"("cleanerId", "status", "startsAt");

-- AddForeignKey
ALTER TABLE "CleanerLeave" ADD CONSTRAINT "CleanerLeave_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanerLeave" ADD CONSTRAINT "CleanerLeave_cleanerId_fkey" FOREIGN KEY ("cleanerId") REFERENCES "CleanerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
