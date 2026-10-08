-- Customer display preference
ALTER TABLE "User" ADD COLUMN "displayCurrency" TEXT;

-- Platform currency configuration
ALTER TABLE "PlatformSettings" ADD COLUMN "supportedDisplayCurrencies" JSONB NOT NULL DEFAULT '["USD","TZS","KES","EUR"]';
ALTER TABLE "PlatformSettings" ADD COLUMN "supportedPaymentCurrencies" JSONB NOT NULL DEFAULT '["USD"]';
ALTER TABLE "PlatformSettings" ADD COLUMN "fxMaxAgeSeconds" INTEGER NOT NULL DEFAULT 86400;

-- Supplier selling currency (does not change when customers switch display currency)
ALTER TABLE "Product" ADD COLUMN "priceCurrency" TEXT NOT NULL DEFAULT 'USD';

-- Locked checkout currency snapshot. Legacy rows keep null FX and are never recomputed.
ALTER TABLE "Order" ADD COLUMN "settlementCurrency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Order" ADD COLUMN "displayCurrency" TEXT;
ALTER TABLE "Order" ADD COLUMN "displaySubtotal" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN "displayTaxAmount" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN "displayDeliveryFee" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN "displayTotal" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN "paymentCurrency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Order" ADD COLUMN "paymentAmount" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN "fxRate" DECIMAL(18,8);
ALTER TABLE "Order" ADD COLUMN "fxBaseCurrency" TEXT;
ALTER TABLE "Order" ADD COLUMN "fxQuoteCurrency" TEXT;
ALTER TABLE "Order" ADD COLUMN "fxFetchedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "fxExpiresAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "fxSource" TEXT;

UPDATE "Order"
SET "settlementCurrency" = UPPER("currency"),
    "paymentCurrency" = UPPER("currency"),
    "currency" = UPPER("currency");

ALTER TABLE "OrderItem" ADD COLUMN "priceCurrency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "OrderItem" ADD COLUMN "displayUnitPrice" DECIMAL(12,2);
ALTER TABLE "OrderItem" ADD COLUMN "displayLineTotal" DECIMAL(12,2);

ALTER TABLE "OrderItemCommission" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';

CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExchangeRate_baseCurrency_quoteCurrency_key" ON "ExchangeRate"("baseCurrency", "quoteCurrency");
CREATE INDEX "ExchangeRate_expiresAt_idx" ON "ExchangeRate"("expiresAt");
