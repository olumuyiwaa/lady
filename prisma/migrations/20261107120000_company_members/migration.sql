-- CreateEnum
CREATE TYPE "CompanyMemberRole" AS ENUM ('ADMIN', 'BRANCH_MANAGER');

-- CreateTable
CREATE TABLE "CompanyMember" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" "CompanyMemberRole" NOT NULL DEFAULT 'BRANCH_MANAGER',
    "locationKeys" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyMember_businessId_email_idx" ON "CompanyMember"("businessId", "email");

-- CreateIndex
CREATE INDEX "CompanyMember_businessId_phone_idx" ON "CompanyMember"("businessId", "phone");

-- CreateIndex
CREATE INDEX "CompanyMember_customerId_idx" ON "CompanyMember"("customerId");

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
