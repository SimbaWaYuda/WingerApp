import { StockStatus } from '@prisma/client';

export type VariantLike = {
  id?: string;
  color: string;
  size: string;
  colorHex?: string | null;
  sku?: string | null;
  stock: number;
  stockStatus: StockStatus | string;
  enabled: boolean;
  sortOrder?: number;
  imageUrl?: string | null;
};

export function stockStatusFor(quantity: number): StockStatus {
  if (quantity <= 0) return StockStatus.OUT_OF_STOCK;
  if (quantity <= 5) return StockStatus.LOW_STOCK;
  return StockStatus.IN_STOCK;
}

export function normalizeVariantAxis(value: string | null | undefined): string {
  return (value ?? '').trim().slice(0, 80);
}

export function productHasVariants(
  variants: VariantLike[] | null | undefined,
): boolean {
  return (variants?.length ?? 0) > 0;
}

/**
 * Resolves sellable stock for a cart/checkout line.
 * Legacy products (no variants) use product.stock.
 * Variant products require a matching enabled variant id.
 */
export function resolveLineStock(input: {
  productStock: number;
  variants?: VariantLike[] | null;
  variantId?: string | null;
}): {
  ok: boolean;
  stock: number;
  variant: VariantLike | null;
  error?: string;
} {
  const variants = input.variants ?? [];
  if (!productHasVariants(variants)) {
    return { ok: true, stock: input.productStock, variant: null };
  }
  const variantId = (input.variantId ?? '').trim();
  if (!variantId) {
    return {
      ok: false,
      stock: 0,
      variant: null,
      error: 'Select a product option before checkout',
    };
  }
  const variant = variants.find((row) => row.id === variantId) ?? null;
  if (!variant || !variant.enabled) {
    return {
      ok: false,
      stock: 0,
      variant: null,
      error: 'Selected product option is unavailable',
    };
  }
  return { ok: true, stock: variant.stock, variant };
}

export function aggregateVariantStock(variants: VariantLike[]): number {
  return variants
    .filter((row) => row.enabled)
    .reduce((sum, row) => sum + Math.max(0, row.stock), 0);
}

export function uniqueColors(variants: VariantLike[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of variants.filter((v) => v.enabled)) {
    const color = normalizeVariantAxis(row.color);
    if (!color || seen.has(color.toLowerCase())) continue;
    seen.add(color.toLowerCase());
    out.push(color);
  }
  return out;
}

export function uniqueSizes(variants: VariantLike[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of variants.filter((v) => v.enabled)) {
    const size = normalizeVariantAxis(row.size);
    if (!size || seen.has(size.toLowerCase())) continue;
    seen.add(size.toLowerCase());
    out.push(size);
  }
  return out;
}

export function findVariantForSelection(
  variants: VariantLike[],
  color: string,
  size: string,
): VariantLike | null {
  const c = normalizeVariantAxis(color).toLowerCase();
  const s = normalizeVariantAxis(size).toLowerCase();
  return (
    variants.find(
      (row) =>
        row.enabled &&
        normalizeVariantAxis(row.color).toLowerCase() === c &&
        normalizeVariantAxis(row.size).toLowerCase() === s,
    ) ?? null
  );
}
