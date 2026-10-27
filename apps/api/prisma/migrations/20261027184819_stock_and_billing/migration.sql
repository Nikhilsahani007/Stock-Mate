-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'SOLD', 'IN_TRANSIT', 'RETURNED_DAMAGED', 'RETURNED_TO_SUPPLIER', 'WRITTEN_OFF', 'VOIDED');

-- CreateEnum
CREATE TYPE "CostConfidence" AS ENUM ('VERIFIED', 'ESTIMATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PartyKind" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('PURCHASE', 'SALE', 'OPENING_STOCK', 'ADJUSTMENT', 'TRANSFER', 'EXPENSE', 'RECEIPT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('POSTED', 'IN_TRANSIT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'BANK');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('RENT', 'SALARY', 'ELECTRICITY', 'TRANSPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('CASH', 'BANK', 'UPI_CARD_CLEARING', 'INVENTORY', 'STOCK_IN_TRANSIT', 'RECEIVABLE', 'GST_INPUT', 'PAYABLE', 'GST_OUTPUT', 'SALES', 'COGS', 'PRICE_VARIANCE', 'STOCK_LOSS', 'EXPENSE', 'OPENING_EQUITY', 'ROUND_OFF');

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandId" TEXT,
    "categoryId" TEXT,
    "isSerialized" BOOLEAN NOT NULL DEFAULT false,
    "hsnCode" TEXT,
    "gstRateBps" INTEGER NOT NULL DEFAULT 1800,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "mrp" INTEGER,
    "salePrice" INTEGER,
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Party" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" "PartyKind" NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "gstin" TEXT,
    "stateCode" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerialUnit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "imei" TEXT NOT NULL,
    "imei2" TEXT,
    "status" "SerialStatus" NOT NULL,
    "unitCost" INTEGER NOT NULL,
    "costConfidence" "CostConfidence" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SerialUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "value" INTEGER NOT NULL DEFAULT 0,
    "costConfidence" "CostConfidence" NOT NULL DEFAULT 'VERIFIED',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("branchId","variantId")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "serialUnitId" TEXT,
    "documentId" TEXT NOT NULL,
    "lineId" TEXT,
    "quantity" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "costConfidence" "CostConfidence" NOT NULL,
    "isReversal" BOOLEAN NOT NULL DEFAULT false,
    "businessDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL,
    "number" TEXT NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "partyId" TEXT,
    "toBranchId" TEXT,
    "gstApplied" BOOLEAN NOT NULL DEFAULT false,
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false,
    "interState" BOOLEAN NOT NULL DEFAULT false,
    "taxableTotal" INTEGER NOT NULL DEFAULT 0,
    "taxTotal" INTEGER NOT NULL DEFAULT 0,
    "otherCharges" INTEGER NOT NULL DEFAULT 0,
    "roundOff" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "expenseCategory" "ExpenseCategory",
    "reason" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "gstRateBps" INTEGER NOT NULL DEFAULT 0,
    "taxableValue" INTEGER NOT NULL,
    "cgst" INTEGER NOT NULL DEFAULT 0,
    "sgst" INTEGER NOT NULL DEFAULT 0,
    "igst" INTEGER NOT NULL DEFAULT 0,
    "lineTotal" INTEGER NOT NULL,
    "costTotal" INTEGER NOT NULL,
    "costConfidence" "CostConfidence",

    CONSTRAINT "DocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineSerial" (
    "lineId" TEXT NOT NULL,
    "serialUnitId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "unitCost" INTEGER NOT NULL,

    CONSTRAINT "LineSerial_pkey" PRIMARY KEY ("lineId","serialUnitId")
);

-- CreateTable
CREATE TABLE "Tender" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT,

    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fromDocumentId" TEXT NOT NULL,
    "toDocumentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "partyId" TEXT,
    "expenseCategory" "ExpenseCategory",
    "debit" INTEGER NOT NULL DEFAULT 0,
    "credit" INTEGER NOT NULL DEFAULT 0,
    "isReversal" BOOLEAN NOT NULL DEFAULT false,
    "businessDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCounter" (
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DocumentCounter_pkey" PRIMARY KEY ("branchId","type","fiscalYear")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_businessId_name_key" ON "Brand"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_id_businessId_key" ON "Brand"("id", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_businessId_name_key" ON "Category"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_id_businessId_key" ON "Category"("id", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_businessId_name_key" ON "Product"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_id_businessId_key" ON "Product"("id", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_productId_name_key" ON "Variant"("productId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_businessId_sku_key" ON "Variant"("businessId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_businessId_barcode_key" ON "Variant"("businessId", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_id_businessId_key" ON "Variant"("id", "businessId");

-- CreateIndex
CREATE INDEX "Party_businessId_name_idx" ON "Party"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Party_id_businessId_key" ON "Party"("id", "businessId");

-- CreateIndex
CREATE INDEX "SerialUnit_businessId_branchId_status_idx" ON "SerialUnit"("businessId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SerialUnit_businessId_imei_key" ON "SerialUnit"("businessId", "imei");

-- CreateIndex
CREATE UNIQUE INDEX "SerialUnit_businessId_imei2_key" ON "SerialUnit"("businessId", "imei2");

-- CreateIndex
CREATE UNIQUE INDEX "SerialUnit_id_businessId_key" ON "SerialUnit"("id", "businessId");

-- CreateIndex
CREATE INDEX "StockBalance_businessId_idx" ON "StockBalance"("businessId");

-- CreateIndex
CREATE INDEX "StockMovement_businessId_branchId_variantId_businessDate_idx" ON "StockMovement"("businessId", "branchId", "variantId", "businessDate");

-- CreateIndex
CREATE INDEX "StockMovement_documentId_idx" ON "StockMovement"("documentId");

-- CreateIndex
CREATE INDEX "Document_businessId_type_businessDate_idx" ON "Document"("businessId", "type", "businessDate");

-- CreateIndex
CREATE INDEX "Document_businessId_partyId_idx" ON "Document"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_branchId_type_number_key" ON "Document"("branchId", "type", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Document_businessId_idempotencyKey_key" ON "Document"("businessId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Document_id_businessId_key" ON "Document"("id", "businessId");

-- CreateIndex
CREATE INDEX "DocumentLine_documentId_idx" ON "DocumentLine"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLine_id_businessId_key" ON "DocumentLine"("id", "businessId");

-- CreateIndex
CREATE INDEX "LineSerial_serialUnitId_idx" ON "LineSerial"("serialUnitId");

-- CreateIndex
CREATE INDEX "Tender_documentId_idx" ON "Tender"("documentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_fromDocumentId_idx" ON "PaymentAllocation"("fromDocumentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_toDocumentId_idx" ON "PaymentAllocation"("toDocumentId");

-- CreateIndex
CREATE INDEX "LedgerEntry_businessId_account_businessDate_idx" ON "LedgerEntry"("businessId", "account", "businessDate");

-- CreateIndex
CREATE INDEX "LedgerEntry_businessId_partyId_idx" ON "LedgerEntry"("businessId", "partyId");

-- CreateIndex
CREATE INDEX "LedgerEntry_documentId_idx" ON "LedgerEntry"("documentId");

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_businessId_fkey" FOREIGN KEY ("brandId", "businessId") REFERENCES "Brand"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_businessId_fkey" FOREIGN KEY ("categoryId", "businessId") REFERENCES "Category"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_businessId_fkey" FOREIGN KEY ("productId", "businessId") REFERENCES "Product"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_variantId_businessId_fkey" FOREIGN KEY ("variantId", "businessId") REFERENCES "Variant"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_branchId_businessId_fkey" FOREIGN KEY ("branchId", "businessId") REFERENCES "Branch"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_branchId_businessId_fkey" FOREIGN KEY ("branchId", "businessId") REFERENCES "Branch"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_variantId_businessId_fkey" FOREIGN KEY ("variantId", "businessId") REFERENCES "Variant"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_branchId_businessId_fkey" FOREIGN KEY ("branchId", "businessId") REFERENCES "Branch"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_variantId_businessId_fkey" FOREIGN KEY ("variantId", "businessId") REFERENCES "Variant"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_serialUnitId_businessId_fkey" FOREIGN KEY ("serialUnitId", "businessId") REFERENCES "SerialUnit"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "Document"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_branchId_businessId_fkey" FOREIGN KEY ("branchId", "businessId") REFERENCES "Branch"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_partyId_businessId_fkey" FOREIGN KEY ("partyId", "businessId") REFERENCES "Party"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_toBranchId_businessId_fkey" FOREIGN KEY ("toBranchId", "businessId") REFERENCES "Branch"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "Document"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_variantId_businessId_fkey" FOREIGN KEY ("variantId", "businessId") REFERENCES "Variant"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineSerial" ADD CONSTRAINT "LineSerial_lineId_businessId_fkey" FOREIGN KEY ("lineId", "businessId") REFERENCES "DocumentLine"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineSerial" ADD CONSTRAINT "LineSerial_serialUnitId_businessId_fkey" FOREIGN KEY ("serialUnitId", "businessId") REFERENCES "SerialUnit"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "Document"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_fromDocumentId_businessId_fkey" FOREIGN KEY ("fromDocumentId", "businessId") REFERENCES "Document"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_toDocumentId_businessId_fkey" FOREIGN KEY ("toDocumentId", "businessId") REFERENCES "Document"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_branchId_businessId_fkey" FOREIGN KEY ("branchId", "businessId") REFERENCES "Branch"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "Document"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_partyId_businessId_fkey" FOREIGN KEY ("partyId", "businessId") REFERENCES "Party"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCounter" ADD CONSTRAINT "DocumentCounter_branchId_businessId_fkey" FOREIGN KEY ("branchId", "businessId") REFERENCES "Branch"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity backstops the posting service also checks. Prisma does not model
-- CHECK constraints, so they live only here.
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_quantity_not_negative" CHECK ("quantity" >= 0);
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_value_not_negative" CHECK ("value" >= 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_one_side" CHECK ("debit" >= 0 AND "credit" >= 0 AND ("debit" = 0 OR "credit" = 0));
ALTER TABLE "DocumentCounter" ADD CONSTRAINT "DocumentCounter_last_positive" CHECK ("last" >= 0);
