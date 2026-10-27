-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentType" ADD VALUE 'SALE_RETURN';
ALTER TYPE "DocumentType" ADD VALUE 'PURCHASE_RETURN';

-- AlterEnum
ALTER TYPE "ExpenseCategory" ADD VALUE 'FINANCE_CHARGES';

-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'SALES_RETURNS';

-- AlterEnum
ALTER TYPE "PartyKind" ADD VALUE 'FINANCIER';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'FINANCE';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "sourceDocumentId" TEXT;

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "damaged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceLineId" TEXT;

-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "partyId" TEXT;

-- CreateIndex
CREATE INDEX "Document_sourceDocumentId_idx" ON "Document"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "DocumentLine_sourceLineId_idx" ON "DocumentLine"("sourceLineId");

-- CreateIndex
CREATE INDEX "Tender_partyId_idx" ON "Tender"("partyId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_sourceDocumentId_businessId_fkey" FOREIGN KEY ("sourceDocumentId", "businessId") REFERENCES "Document"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_sourceLineId_businessId_fkey" FOREIGN KEY ("sourceLineId", "businessId") REFERENCES "DocumentLine"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_partyId_businessId_fkey" FOREIGN KEY ("partyId", "businessId") REFERENCES "Party"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A phone model's stock tag is the weakest cost among the devices still in
-- stock, not every device it has held since stock was last zero.
WITH weakest AS (
  SELECT "branchId", "variantId",
    MAX(CASE "costConfidence" WHEN 'VERIFIED' THEN 0 WHEN 'ESTIMATED' THEN 1 ELSE 2 END) AS rank
  FROM "SerialUnit" WHERE "status" = 'IN_STOCK'
  GROUP BY 1, 2
)
UPDATE "StockBalance" sb
SET "costConfidence" = (CASE w.rank WHEN 0 THEN 'VERIFIED' WHEN 1 THEN 'ESTIMATED' ELSE 'UNKNOWN' END)::"CostConfidence"
FROM weakest w
WHERE sb."branchId" = w."branchId" AND sb."variantId" = w."variantId";
