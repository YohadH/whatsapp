-- Credit pack purchases (top-ups). See CREDITS_DESIGN.md.
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amountIls" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CreditPurchase_tenantId_status_idx" ON "CreditPurchase"("tenantId", "status");
CREATE INDEX "CreditPurchase_status_createdAt_idx" ON "CreditPurchase"("status", "createdAt");
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
