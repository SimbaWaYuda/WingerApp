-- Tanzania customers pay in TZS. USD stays payable for settlement and other customers.
ALTER TABLE "PlatformSettings"
  ALTER COLUMN "supportedPaymentCurrencies" SET DEFAULT '["USD","TZS"]';

UPDATE "PlatformSettings"
SET "supportedPaymentCurrencies" = '["USD","TZS"]'::jsonb
WHERE id = 'default'
  AND "supportedPaymentCurrencies" = '["USD"]'::jsonb;
