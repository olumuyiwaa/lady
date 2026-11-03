-- Transaction log: one row per money event (see the model comment in schema.prisma).
-- Hand-written to match `prisma migrate diff` output. Confirm there is no drift with:
--   git show <commit before this one>:prisma/schema.prisma > /tmp/before.prisma
--   npx prisma migrate diff --from-schema-datamodel /tmp/before.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script
-- The output should equal this file's statements.
--
-- Existing data is NOT copied here. After deploying, run once:
--   node scripts/backfillTransactions.js
-- (safe to re-run; it skips events that are already recorded).

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('BOOKING_PAYMENT', 'DEPOSIT', 'TIP', 'REFUND', 'DISPUTE', 'CLEANER_PAYOUT', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "TransactionDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('SUCCEEDED', 'PENDING', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "TransactionMethod" AS ENUM ('STRIPE', 'CASH', 'BANK_TRANSFER', 'INVOICE', 'OTHER');

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "method" "TransactionMethod" NOT NULL DEFAULT 'STRIPE',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "counterpartyName" TEXT,
    "reference" TEXT,
    "bookingId" TEXT,
    "customerId" TEXT,
    "cleanerId" TEXT,
    "payoutId" TEXT,
    "platformInvoiceId" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeRefundId" TEXT,
    "stripeTransferId" TEXT,
    "stripeInvoiceId" TEXT,
    "stripeDisputeId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "backfilled" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_dedupeKey_key" ON "Transaction"("dedupeKey");

-- CreateIndex
CREATE INDEX "Transaction_businessId_occurredAt_idx" ON "Transaction"("businessId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Transaction_businessId_type_occurredAt_idx" ON "Transaction"("businessId", "type", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Transaction_occurredAt_idx" ON "Transaction"("occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Transaction_bookingId_idx" ON "Transaction"("bookingId");

-- CreateIndex
CREATE INDEX "Transaction_stripePaymentIntentId_idx" ON "Transaction"("stripePaymentIntentId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
