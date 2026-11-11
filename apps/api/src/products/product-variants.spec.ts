import { StockStatus } from '@prisma/client';
import {
  findVariantForSelection,
  productHasVariants,
  resolveLineStock,
  uniqueColors,
  uniqueSizes,
} from './product-variants';

const variants = [
  {
    id: 'v-pink-38',
    color: 'Pink',
    size: '38',
    stock: 5,
    stockStatus: StockStatus.LOW_STOCK,
    enabled: true,
  },
  {
    id: 'v-pink-39',
    color: 'Pink',
    size: '39',
    stock: 0,
    stockStatus: StockStatus.OUT_OF_STOCK,
    enabled: true,
  },
  {
    id: 'v-black-38',
    color: 'Black',
    size: '38',
    stock: 3,
    stockStatus: StockStatus.LOW_STOCK,
    enabled: true,
  },
];

describe('product-variants', () => {
  it('keeps legacy products on product stock', () => {
    expect(productHasVariants([])).toBe(false);
    expect(
      resolveLineStock({ productStock: 12, variants: [], variantId: null }),
    ).toEqual({ ok: true, stock: 12, variant: null });
  });

  it('requires a variant when options exist', () => {
    const missing = resolveLineStock({
      productStock: 99,
      variants,
      variantId: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.stock).toBe(0);
  });

  it('resolves per-combination stock', () => {
    expect(
      resolveLineStock({
        productStock: 99,
        variants,
        variantId: 'v-pink-38',
      }).stock,
    ).toBe(5);
    expect(
      resolveLineStock({
        productStock: 99,
        variants,
        variantId: 'v-pink-39',
      }).stock,
    ).toBe(0);
    expect(
      resolveLineStock({
        productStock: 99,
        variants,
        variantId: 'v-black-38',
      }).stock,
    ).toBe(3);
  });

  it('lists unique colours and sizes and finds combinations', () => {
    expect(uniqueColors(variants)).toEqual(['Pink', 'Black']);
    expect(uniqueSizes(variants)).toEqual(['38', '39']);
    expect(findVariantForSelection(variants, 'Pink', '38')?.id).toBe(
      'v-pink-38',
    );
    expect(findVariantForSelection(variants, 'Pink', '40')).toBeNull();
  });
});
