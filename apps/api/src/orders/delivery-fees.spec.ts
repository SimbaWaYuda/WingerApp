import { computeFulfillmentFees, deliveryFeeForSupplier } from './delivery-fees';

const kijani = {
  supplierId: 's-kijani',
  supplierName: 'Kijani Tech',
  merchandiseSubtotal: 40,
  standardDeliveryFee: 4.99,
  expressDeliveryFee: 9.99,
  pickupDeliveryFee: 0,
  freeDeliveryThreshold: 50,
  taxRatePercent: 8,
  taxOnDelivery: false,
  carrier: 'supplier' as const,
  courierName: null,
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

  it('uses each supplier tax rate and can include the delivery fee', () => {
    const quote = computeFulfillmentFees({
      subtotal: 100,
      deliveryMethod: 'standard',
      suppliers: [
        { ...kijani, taxRatePercent: 16, taxOnDelivery: true },
        { ...kijani, supplierName: 'Atlas Home', merchandiseSubtotal: 60, taxRatePercent: 0 },
      ],
    });
    expect(quote.shipments.map((shipment) => shipment.tax)).toEqual([7.2, 0]);
    expect(quote.tax).toBe(7.2);
    expect(quote.total).toBe(roundTotal(100, quote.deliveryFee, quote.tax));
  });

  it('records supplier delivery, a named courier, and no carrier on pickup', () => {
    const supplierDelivery = computeFulfillmentFees({
      subtotal: 40,
      deliveryMethod: 'standard',
      suppliers: [kijani],
    });
    expect(supplierDelivery.shipments[0].carrier).toBe('supplier');
    expect(supplierDelivery.shipments[0].courierName).toBeNull();

    const courier = computeFulfillmentFees({
      subtotal: 40,
      deliveryMethod: 'express',
      suppliers: [{ ...kijani, carrier: 'courier', courierName: ' Sendy ' }],
    });
    expect(courier.shipments[0].carrier).toBe('courier');
    expect(courier.shipments[0].courierName).toBe('Sendy');

    const pickup = computeFulfillmentFees({
      subtotal: 40,
      deliveryMethod: 'pickup',
      suppliers: [{ ...kijani, carrier: 'courier', courierName: 'Sendy' }],
    });
    expect(pickup.shipments[0].carrier).toBeNull();
    expect(pickup.shipments[0].courierName).toBeNull();
  });
});

function roundTotal(subtotal: number, deliveryFee: number, tax: number): number {
  return Math.round((subtotal + deliveryFee + tax) * 100) / 100;
}
