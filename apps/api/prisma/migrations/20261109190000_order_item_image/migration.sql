-- Snapshot product image on order lines so customer order history can show
-- what was purchased even if the catalog image later changes.
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;

UPDATE "OrderItem" AS oi
SET "imageUrl" = sub.img
FROM (
  SELECT
    oi2."id" AS id,
    COALESCE(pv."imageUrl", p."imageUrl") AS img
  FROM "OrderItem" AS oi2
  INNER JOIN "Product" AS p ON p."id" = oi2."productId"
  LEFT JOIN "ProductVariant" AS pv ON pv."id" = oi2."variantId"
) AS sub
WHERE oi."id" = sub.id
  AND (oi."imageUrl" IS NULL OR oi."imageUrl" = '');
