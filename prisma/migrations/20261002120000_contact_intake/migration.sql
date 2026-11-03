-- Contact intake: business contact details, website-contact fields on support
-- tickets, an "emailed" marker on ticket replies, and the platform inbox.
-- Hand-written to match `prisma migrate diff` output. Confirm there is no drift with:
--   git show <commit before this one>:prisma/schema.prisma > /tmp/before.prisma
--   npx prisma migrate diff --from-schema-datamodel /tmp/before.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script
-- The output should equal this file's statements.

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactPhone" TEXT;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "SupportTicketMessage" ADD COLUMN     "emailedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PlatformInquiry" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT,
    "subject" TEXT,
    "category" TEXT,
    "message" TEXT,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "handledBy" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "ackSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformInquiry_reference_key" ON "PlatformInquiry"("reference");

-- CreateIndex
CREATE INDEX "PlatformInquiry_status_createdAt_idx" ON "PlatformInquiry"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformInquiry_kind_createdAt_idx" ON "PlatformInquiry"("kind", "createdAt");
