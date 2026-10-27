-- CreateEnum
CREATE TYPE "CashHandover" AS ENUM ('BANK', 'OWNER');

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'DAY_CLOSE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerAccount" ADD VALUE 'CASH_OVER_SHORT';
ALTER TYPE "LedgerAccount" ADD VALUE 'OWNER_DRAWINGS';

-- CreateTable
CREATE TABLE "DayClose" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "documentId" TEXT NOT NULL,
    "openingCash" INTEGER NOT NULL,
    "openingFloat" INTEGER NOT NULL DEFAULT 0,
    "cashIn" INTEGER NOT NULL,
    "cashOut" INTEGER NOT NULL,
    "expectedCash" INTEGER NOT NULL,
    "countedCash" INTEGER NOT NULL,
    "difference" INTEGER NOT NULL,
    "handedOver" INTEGER NOT NULL DEFAULT 0,
    "handedOverTo" "CashHandover",
    "summary" JSONB NOT NULL,
    "notes" TEXT,
    "closedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT,

    CONSTRAINT "DayClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DayClose_businessId_branchId_businessDate_idx" ON "DayClose"("businessId", "branchId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "DayClose_documentId_businessId_key" ON "DayClose"("documentId", "businessId");

-- AddForeignKey
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_branchId_businessId_fkey" FOREIGN KEY ("branchId", "businessId") REFERENCES "Branch"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "Document"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
