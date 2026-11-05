-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "kind" TEXT,
ADD COLUMN "cleanerId" TEXT,
ADD COLUMN "dueAt" TIMESTAMP(3),
ADD COLUMN "firstResponseAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SupportTicket_businessId_kind_idx" ON "SupportTicket"("businessId", "kind");

-- CreateIndex
CREATE INDEX "SupportTicket_bookingId_idx" ON "SupportTicket"("bookingId");
