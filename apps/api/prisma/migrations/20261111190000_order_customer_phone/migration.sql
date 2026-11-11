ALTER TABLE "Order" ADD COLUMN "customerPhone" TEXT;

UPDATE "Order" AS o
SET "customerPhone" = btrim(u.phone)
FROM "User" AS u
WHERE o."customerId" = u.id
  AND u.phone IS NOT NULL
  AND btrim(u.phone) <> ''
  AND btrim(u.phone) <> '—'
  AND btrim(u.phone) <> '-';
