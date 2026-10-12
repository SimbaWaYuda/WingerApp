import { computeFulfillmentFees, deliveryFeeForSupplier } from './delivery-fees';

const kijani = {
  supplierName: 'Kijani Tech',
  merchandiseSubtotal: 40,
  standardDeliveryFee: 4.99,
  expressDeliveryFee: 9.99,
  pickupDeliveryFee: 0,
  freeDeliveryThreshold: 50,
};

describe('delivery fees', () => {
  it('uses each supplier fee and keeps a zero fee free', () => {
    expect(deliveryFeeForSupplier('standard', kijani)).toBe(4.99);
    expect(deliveryFeeForSupplier('express', kijani)).toBe(9.99);
    expect(deliveryFeeForSupplier('pickup', kijani)).toBe(0);
    expect(
      deliveryFeeForSupplier('standard', { ...kijani, standardDeliveryFee: 0 }),
    ).toBe(0);
  });

  it('drops standard delivery once that supplier’s items reach the threshold', () => {
    expect(
      deliveryFeeForSupplier('standard', { ...kijani, merchandiseSubtotal: 50 }),
    ).toBe(0);
    expect(
      deliveryFeeForSupplier('express', { ...kijani, merchandiseSubtotal: 80 }),
    ).toBe(9.99);
  });

  it('adds a fee for every supplier and leaves tax on the product subtotal', () => {
    const quote = computeFulfillmentFees({
      subtotal: 100,
      deliveryMethod: 'standard',
      city: 'Nairobi',
      suppliers: [
        kijani,
        {
          ...kijani,
          supplierName: 'Atlas Home',
          merchandiseSubtotal: 60,
          standardDeliveryFee: 3,
          freeDeliveryThreshold: 50,
        },
      ],
    });
    expect(quote.deliveryFee).toBe(4.99);
    expect(quote.tax).toBe(8);
    expect(quote.total).toBe(112.99);
    expect(quote.shipments.map((shipment) => shipment.fee)).toEqual([4.99, 0]);
  });
});
