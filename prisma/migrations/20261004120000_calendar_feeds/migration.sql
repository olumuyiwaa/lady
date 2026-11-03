-- Calendar subscription feeds (iCalendar links for owners, managers and cleaners).
-- Hand-written to match `prisma migrate diff` output. Confirm there is no drift with:
--   git show <commit before this one>:prisma/schema.prisma > /tmp/before.prisma
--   npx prisma migrate diff --from-schema-datamodel /tmp/before.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script
-- The output should equal this file's statements.

-- CreateTable
CREATE TABLE "CalendarFeed" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cleanerId" TEXT,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "tokenHash" TEXT NOT NULL,
    "lastAccessedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarFeed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarFeed_tokenHash_key" ON "CalendarFeed"("tokenHash");

-- CreateIndex
CREATE INDEX "CalendarFeed_businessId_revokedAt_idx" ON "CalendarFeed"("businessId", "revokedAt");

-- CreateIndex
CREATE INDEX "CalendarFeed_cleanerId_idx" ON "CalendarFeed"("cleanerId");

-- AddForeignKey
ALTER TABLE "CalendarFeed" ADD CONSTRAINT "CalendarFeed_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarFeed" ADD CONSTRAINT "CalendarFeed_cleanerId_fkey" FOREIGN KEY ("cleanerId") REFERENCES "CleanerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
